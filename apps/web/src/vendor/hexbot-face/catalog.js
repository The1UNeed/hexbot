const defineCatalog = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const STATE_GROUPS = defineCatalog([
  {
    id: "lifecycle",
    label: Object.freeze({ en: "Lifecycle", zh: "基础状态" }),
    states: Object.freeze(["idle", "sleeping", "waking", "listening", "thinking", "searching", "working"]),
  },
  {
    id: "reactions",
    label: Object.freeze({ en: "Reactions", zh: "情绪反应" }),
    states: Object.freeze(["excited", "surprised", "suspicious", "angry", "drowsy", "happy", "curious", "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful", "celebrate"]),
  },
  {
    id: "agent-morphs",
    label: Object.freeze({ en: "Agent morphs", zh: "Agent 形变" }),
    states: Object.freeze(["orbit", "radar", "progress"]),
  },
  {
    id: "product-lifecycle",
    label: Object.freeze({ en: "Product lifecycle", zh: "任务状态" }),
    states: Object.freeze(["spawning", "humming", "loading", "dictating", "writing", "sending", "receiving", "uploading", "notifying", "alerting", "dragging", "bouncing", "powering-down"]),
  },
]);

export const STATE_CATALOG = defineCatalog([
  { id: "idle", en: "Idle", zh: "待机" },
  { id: "sleeping", en: "Sleeping", zh: "睡眠" },
  { id: "waking", en: "Waking", zh: "醒来" },
  { id: "listening", en: "Listening", zh: "倾听" },
  { id: "thinking", en: "Thinking", zh: "思考", morph: "dots" },
  { id: "searching", en: "Searching", zh: "搜索" },
  { id: "working", en: "Working", zh: "工作" },
  { id: "excited", en: "Excited", zh: "兴奋" },
  { id: "surprised", en: "Surprised", zh: "惊讶" },
  { id: "suspicious", en: "Suspicious", zh: "怀疑" },
  { id: "angry", en: "Angry", zh: "生气" },
  { id: "drowsy", en: "Drowsy", zh: "困倦" },
  { id: "happy", en: "Happy", zh: "开心" },
  { id: "curious", en: "Curious", zh: "好奇" },
  { id: "confused", en: "Confused", zh: "困惑" },
  { id: "bored", en: "Bored", zh: "无聊" },
  { id: "proud", en: "Proud", zh: "得意" },
  { id: "shy", en: "Shy", zh: "害羞" },
  { id: "sad", en: "Sad", zh: "难过" },
  { id: "laughing", en: "Laughing", zh: "大笑" },
  { id: "scared", en: "Scared", zh: "害怕" },
  { id: "playful", en: "Playful", zh: "调皮" },
  { id: "celebrate", en: "Celebrate", zh: "庆祝" },
  { id: "orbit", en: "Orbit", zh: "轨道", morph: "orbit" },
  { id: "radar", en: "Radar", zh: "雷达", morph: "radar" },
  { id: "progress", en: "Progress", zh: "进度", morph: "progress" },
  { id: "spawning", en: "Spawning", zh: "生成", morph: "gather" },
  { id: "humming", en: "Humming", zh: "运转" },
  { id: "loading", en: "Loading", zh: "加载", morph: "whirl" },
  { id: "dictating", en: "Dictating", zh: "听写", morph: "wave" },
  { id: "writing", en: "Writing", zh: "书写", morph: "pencil" },
  { id: "sending", en: "Sending", zh: "发送", morph: "send" },
  { id: "receiving", en: "Receiving", zh: "接收", morph: "receive" },
  { id: "uploading", en: "Uploading", zh: "上传", morph: "dock" },
  { id: "notifying", en: "Notifying", zh: "通知" },
  { id: "alerting", en: "Alerting", zh: "警报", morph: "bang" },
  { id: "dragging", en: "Dragging", zh: "拖拽" },
  { id: "bouncing", en: "Bouncing", zh: "弹跳", morph: "ball" },
  { id: "powering-down", en: "Powering down", zh: "关机", morph: "standby" },
]);

export const SHAPE_CATALOG = defineCatalog([
  { id: "blob", en: "Blob", zh: "圆形" },
  { id: "pebble", en: "Pebble", zh: "卵石" },
  { id: "bean", en: "Bean", zh: "豆形" },
  { id: "egg", en: "Egg", zh: "蛋形" },
  { id: "squircle", en: "Squircle", zh: "圆角方形" },
  { id: "tablet", en: "Tablet", zh: "圆角矩形" },
  { id: "capsule", en: "Capsule", zh: "胶囊" },
  { id: "cylinder", en: "Cylinder", zh: "圆柱" },
  { id: "hex", en: "Hexagon", zh: "六边形" },
  { id: "gem", en: "Gem", zh: "宝石" },
  { id: "crystal", en: "Crystal", zh: "水晶" },
  { id: "wedge", en: "Wedge", zh: "三角楔形" },
  { id: "shield", en: "Shield", zh: "盾牌" },
  { id: "dome", en: "Dome", zh: "拱顶" },
  { id: "arch", en: "Arch", zh: "拱门" },
  { id: "cloud", en: "Cloud", zh: "云朵" },
  { id: "teardrop", en: "Teardrop", zh: "水滴" },
  { id: "leaf", en: "Leaf", zh: "叶片" },
]);

export const MORPH_CATALOG = defineCatalog([
  { id: "dots", en: "Thinking dots", zh: "思考点阵" },
  { id: "orbit", en: "Color orbit", zh: "彩色轨道" },
  { id: "radar", en: "Radar scan", zh: "雷达扫描" },
  { id: "progress", en: "Progress loop", zh: "循环进度" },
  { id: "gather", en: "Gather", zh: "聚合生成" },
  { id: "wave", en: "Audio wave", zh: "声音波形" },
  { id: "send", en: "Send", zh: "向外发送" },
  { id: "receive", en: "Receive", zh: "接收进入" },
  { id: "dock", en: "Upload dock", zh: "上传停靠" },
  { id: "ball", en: "Bounce ball", zh: "弹跳球体" },
  { id: "whirl", en: "Loading whirl", zh: "旋转加载" },
  { id: "pencil", en: "Writing pencil", zh: "书写铅笔" },
  { id: "bang", en: "Alert", zh: "警报符号" },
  { id: "standby", en: "Standby", zh: "待机关机" },
]);

const labels = (catalog, locale) => Object.freeze(Object.fromEntries(catalog.map((item) => [item.id, item[locale]])));

export const STATE_IDS = Object.freeze(STATE_CATALOG.map(({ id }) => id));
export const SHAPE_IDS = Object.freeze(SHAPE_CATALOG.map(({ id }) => id));
export const MORPH_IDS = Object.freeze(MORPH_CATALOG.map(({ id }) => id));
export const STATE_LABELS_ZH = labels(STATE_CATALOG, "zh");
export const STATE_LABELS_EN = labels(STATE_CATALOG, "en");
export const SHAPE_LABELS_ZH = labels(SHAPE_CATALOG, "zh");
export const SHAPE_LABELS_EN = labels(SHAPE_CATALOG, "en");
export const MORPH_LABELS_ZH = labels(MORPH_CATALOG, "zh");
export const MORPH_LABELS_EN = labels(MORPH_CATALOG, "en");
export const MORPH_BY_STATE = Object.freeze(Object.fromEntries(
  STATE_CATALOG.flatMap(({ id, morph }) => morph ? [[id, morph]] : []),
));
