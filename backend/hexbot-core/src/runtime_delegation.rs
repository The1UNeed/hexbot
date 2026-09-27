use super::*;

pub(super) struct Child {
    pub row: Value,
    pub stop: watch::Sender<bool>,
}
pub(super) fn descriptor() -> Value {
    json!({"name":"delegate_task","description":"Start isolated subagents in the background. Their results return to this conversation automatically. Use list, steer, or stop to control children.","parameters":{"type":"object","properties":{"tasks":{"type":"array","items":{"type":"object","properties":{"goal":{"type":"string"},"context":{"type":"string"},"output_schema":{"type":"object"}},"required":["goal"]}},"goal":{"type":"string"},"context":{"type":"string"},"action":{"type":"string","enum":["spawn","list","steer","stop"]},"subagent_id":{"type":"string"},"message":{"type":"string"}}}})
}
impl Runtime {
    pub(super) async fn delegate(&self, s: &Arc<Live>, args: &Value) -> Result<Value> {
        let action = args["action"].as_str().unwrap_or("spawn");
        if action == "list" {
            let rows = self
                .children
                .lock()
                .unwrap()
                .values()
                .filter(|c| c.row["parent"] == s.stored)
                .map(|c| c.row.clone())
                .collect::<Vec<_>>();
            let rows = rows
                .into_iter()
                .map(|mut row| {
                    row["messages"] = json!(
                        store::history(&self.home, row["subagent_id"].as_str().unwrap_or(""))
                            .unwrap_or_default()
                    );
                    row
                })
                .collect::<Vec<_>>();
            return Ok(json!({"subagents":rows}));
        }
        if matches!(action, "stop" | "steer") {
            let id = required(args, "subagent_id")?;
            {
                let children = self.children.lock().unwrap();
                let child = children
                    .get(id)
                    .filter(|c| c.row["parent"] == s.stored)
                    .ok_or_else(|| Error::new(4204, "subagent not found"))?;
                if action == "stop" {
                    child.stop.send_replace(true);
                }
            }
            if action == "stop" {
                self.interrupt_stored(&s.owner, id).await?;
                return Ok(json!({"status":"stopping","subagent_id":id}));
            }
            let target = self
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| Error::new(4204, "subagent is not running"))?;
            Self::command(
                &target,
                json!({"type":"steer","message":required(args,"message")?}),
            )
            .await?;
            return Ok(json!({"status":"steered","subagent_id":id}));
        }
        if action != "spawn" {
            return Err(Error::new(4202, "invalid delegation action"));
        }
        let tasks = args["tasks"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![args.clone()]);
        if tasks.is_empty() {
            return Err(Error::new(4202, "at least one task is required"));
        }
        for task in &tasks {
            required(task, "goal")?;
        }
        let config = common::read_config(&self.home)?;
        let max_children = config["delegation"]["max_concurrent_children"]
            .as_u64()
            .unwrap_or(3)
            .clamp(1, 32) as usize;
        let max_depth = config["delegation"]["max_spawn_depth"]
            .as_u64()
            .unwrap_or(2)
            .clamp(1, 8);
        let current_depth = self
            .children
            .lock()
            .unwrap()
            .get(&s.stored)
            .and_then(|c| c.row["depth"].as_u64())
            .unwrap_or(0);
        if current_depth >= max_depth {
            return Err(Error::new(4202, "subagent depth limit reached"));
        }
        let saved: String = store::open(&self.home)?.query_row(
            "SELECT options FROM native_sessions WHERE stored_id=?",
            [&s.stored],
            |r| r.get(0),
        )?;
        let saved: Value =
            serde_json::from_str(&saved).map_err(|e| Error::new(5200, e.to_string()))?;
        let mut tools = s
            .tools
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .filter(|n| n != "clarify")
            .collect::<Vec<_>>();
        if current_depth + 1 >= max_depth {
            tools.retain(|n| n != "delegate_task");
        }
        if let Some(restricted) = saved["restricted"].as_array() {
            for tool in ["read", "write", "edit", "grep", "find", "ls", "bash"] {
                if restricted.iter().any(|n| n == tool) {
                    tools.push(tool.into());
                }
            }
        } else {
            let enabled = saved["enabledToolsets"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if enabled.iter().any(|t| t == "file") {
                tools.extend(["read", "write", "edit", "grep", "find", "ls"].map(str::to_owned));
            }
            if enabled.iter().any(|t| t == "terminal") {
                tools.push("bash".into());
            }
        }
        let options = json!({"enabled_tools":tools,"model":saved["model"],"provider":saved["provider"],"workdir":saved["cwd"],"reasoning_effort":saved["reasoning_effort"],"parent_session":s.stored});
        let runtime = self
            .weak
            .upgrade()
            .ok_or_else(|| Error::new(5201, "daemon is stopping"))?;
        let delegation = common::id();
        let mut children = vec![];
        {
            let mut all = self.children.lock().unwrap();
            let active = all
                .values()
                .filter(|c| c.row["parent"] == s.stored && c.row["status"] == "running")
                .count();
            if active + tasks.len() > max_children {
                return Err(Error::new(
                    4202,
                    format!("at most {max_children} subagents can run at once"),
                ));
            }
            for task in tasks {
                let id = format!("child-{}", common::id());
                let (stop, receiver) = watch::channel(false);
                let row = json!({"subagent_id":id,"parent":s.stored,"goal":task["goal"],"status":"running","depth":current_depth+1,"delegation_id":delegation,"started_at":common::now()});
                all.insert(id.clone(), Child { row, stop });
                children.push((id, task, receiver));
            }
        }
        let ids = children
            .iter()
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>();
        let source = s.clone();
        let workers=children.into_iter().map(|(id,task,mut stop)|{
            let runtime=runtime.clone();let source=source.clone();let options=options.clone();
            tokio::spawn(async move {
                let prompt=format!("Complete this delegated task independently. Return your result to the parent bot.\n\nTask: {}\n\nContext: {}{}",task["goal"].as_str().unwrap_or(""),task["context"].as_str().unwrap_or(""),if task["output_schema"].is_object(){format!("\n\nRespond as JSON matching this schema: {}",task["output_schema"])}else{String::new()});
                let mut result=tokio::select!{result=runtime.run_hidden_job(&source.owner,&source.bot,&id,&prompt,&options)=>result,_=async{loop{if *stop.borrow(){break;}
                if stop.changed().await.is_err(){break;}}}=>Err(Error::new(5201,"subagent stopped"))};
                if task["output_schema"].is_object() && !*stop.borrow() && let Ok(text)=&result {let errors=serde_json::from_str::<Value>(text).map(|v|validate(&v,&task["output_schema"],"$")).unwrap_or_else(|_|vec!["response is not JSON".into()]);
                    if !errors.is_empty(){let correction=format!("Correct only the JSON form of your final answer. Do not repeat the task or any completed actions. Return JSON matching {}. Validation errors: {}",task["output_schema"],errors.join("; "));result=tokio::select!{result=runtime.run_hidden_job(&source.owner,&source.bot,&id,&correction,&options)=>result,_=stop.changed()=>Err(Error::new(5201,"subagent stopped"))};}
                }
                let _=runtime.close_stored(&source.owner,&id).await;
                {let mut all=runtime.children.lock().unwrap();let child=all.get_mut(&id).unwrap();child.row["status"]=json!(if result.is_ok(){"complete"}else{"failed"});child.row["finished_at"]=json!(common::now());match result{Ok(text)=>{child.row["result"]=json!(text);if task["output_schema"].is_object(){let parsed=serde_json::from_str::<Value>(&text);let errors=parsed.as_ref().map(|v|validate(v,&task["output_schema"],"$")).unwrap_or_else(|_|vec!["response is not JSON".into()]);child.row["schema_valid"]=json!(errors.is_empty());child.row["schema_errors"]=json!(errors);}},Err(error)=>child.row["error"]=json!(error.message)};child.row.clone()}
            })
        }).collect::<Vec<_>>();
        let source = s.clone();
        tokio::spawn(async move {
            let results = futures_util::future::join_all(workers)
                .await
                .into_iter()
                .map(|r| {
                    r.unwrap_or_else(
                        |_| json!({"status":"failed","error":"subagent worker exited"}),
                    )
                })
                .collect::<Vec<_>>();
            let text = format!(
                "[Delegated tasks completed]\n{}",
                json!({"results":results})
            );
            let _ = runtime.submit(&source, &text, true, true).await;
        });
        Ok(
            json!({"status":"dispatched","mode":"background","count":ids.len(),"delegation_id":delegation,"subagent_ids":ids,"note":"Subagents are running. Continue working; their results return automatically."}),
        )
    }
}
struct NoExternalSchemas;
impl jsonschema::Retrieve for NoExternalSchemas {
    fn retrieve(
        &self,
        _uri: &jsonschema::Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("external schema references are disabled".into())
    }
}
fn validate(value: &Value, schema: &Value, _path: &str) -> Vec<String> {
    match jsonschema::options()
        .with_retriever(NoExternalSchemas)
        .build(schema)
    {
        Ok(validator) => validator
            .iter_errors(value)
            .take(16)
            .map(|error| error.to_string())
            .collect(),
        Err(error) => vec![format!("Invalid output schema: {error}")],
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    #[test]
    fn structured_output_supports_local_refs_and_full_constraints() {
        let schema = json!({"$defs":{"item":{"type":"string","pattern":"^[a-z]+$","minLength":2}},"type":"object","required":["items"],"additionalProperties":false,"properties":{"items":{"type":"array","minItems":1,"uniqueItems":true,"items":{"$ref":"#/$defs/item"}}}});
        assert!(validate(&json!({"items":["good"]}), &schema, "$").is_empty());
        for value in [
            json!({"items":[]}),
            json!({"items":["a"]}),
            json!({"items":["AA"]}),
            json!({"items":["yes","yes"]}),
            json!({"items":["yes"],"extra":true}),
        ] {
            assert!(!validate(&value, &schema, "$").is_empty());
        }
        assert!(
            !validate(
                &json!(null),
                &json!({"$ref":"https://example.com/schema"}),
                "$"
            )
            .is_empty()
        );
    }
}
