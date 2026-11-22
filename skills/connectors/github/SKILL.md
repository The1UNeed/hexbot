---
name: github
description: "Read and work on the user's GitHub: repositories, issues, pull requests and files."
version: 1.0.0
author: Hexbot
license: MIT
prerequisites:
  env_vars: [HEXBOT_GITHUB_TOKEN]
---

# GitHub

You reach GitHub through its REST API with two tools: `hexbot_connector_read` for reads and `hexbot_connector_write` for changes. Pass `connector: "github"`, the `method`, the `path` (such as `/user/repos`) and a JSON `body` when there is one. Hexbot adds the host, the token the user saved in Settings, Plugins, and GitHub's headers. Your shell never has the token, so don't use `gh auth`, `curl` with a token or a browser sign-in, and never ask the user for a token or password.

The token sees only the repositories and permissions the user gave it. A 404 for a repository that exists usually means the token can't see it; a 401 means the token is wrong or expired; a 403 names a missing permission. Send the user to [GitHub](hexbot:plugin/github) for any of these.

## Reads (`hexbot_connector_read`)

| Job | Method and path |
| --- | --- |
| Who the token belongs to | `GET /user` |
| The user's repositories | `GET /user/repos?sort=updated&per_page=30` |
| One repository | `GET /repos/{owner}/{repo}` |
| Open issues | `GET /repos/{owner}/{repo}/issues?state=open&per_page=30` |
| One issue and its comments | `GET /repos/{owner}/{repo}/issues/{number}`, then `.../comments` |
| Open pull requests | `GET /repos/{owner}/{repo}/pulls?state=open` |
| A pull request's changed files | `GET /repos/{owner}/{repo}/pulls/{number}/files` |
| A file's contents (base64) | `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` |
| Search issues and pull requests | `GET /search/issues?q=repo:{owner}/{repo}+is:open+label:bug` |
| Search code | `GET /search/code?q=TODO+repo:{owner}/{repo}` |
| Workflow runs | `GET /repos/{owner}/{repo}/actions/runs?per_page=10` |

Lists come in pages: pass `page=2` and so on while the answer is full. Search terms in `q` are joined with `+`.

## Changes (`hexbot_connector_write`)

Your approval mode decides whether a change runs at once or asks the user first, so make each one complete.

| Job | Method and path | Body |
| --- | --- | --- |
| Open an issue | `POST /repos/{owner}/{repo}/issues` | `{"title": "…", "body": "…", "labels": ["bug"]}` |
| Comment on an issue or pull request | `POST /repos/{owner}/{repo}/issues/{number}/comments` | `{"body": "…"}` |
| Close an issue | `PATCH /repos/{owner}/{repo}/issues/{number}` | `{"state": "closed"}` |
| Open a pull request | `POST /repos/{owner}/{repo}/pulls` | `{"title": "…", "head": "branch", "base": "main", "body": "…"}` |
| Review a pull request | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` | `{"event": "COMMENT", "body": "…"}` |

To change code, clone and push from a computer you can use instead: `git clone https://github.com/{owner}/{repo}` on the bots' computer works for public repositories. Never merge, delete a branch or change repository settings unless the user asked for exactly that.
