export interface ExperimentConfig {
  id: string;
  label: string;
  title: string;
  introduction: string;
  requirements: string[];
  material: string;
  hint: string;
  assistantName: string;
  welcome: string;
  taskVisible: boolean;
  chatEnabled: boolean;
}

export const experiment: ExperimentConfig = {
  id: process.env.EXPERIMENT_ID ?? "learning-scenario-v1",
  label: "实验任务 · 01",
  title: "借助 AI 分析一则学习情境",
  introduction: "请阅读下面的任务说明，并通过右侧对话与 AI 一起完成分析。你可以追问、质疑或请 AI 解释。",
  requirements: ["识别情境中的核心学习问题。", "向 AI 提出至少两个有针对性的问题。", "结合 AI 的回答，形成你自己的判断。"],
  material: "一名学生能够记住公式，却很难解释公式的含义，也无法把它应用到新的问题中。请思考：这反映了怎样的学习状态？",
  hint: "AI 的回答只是思考材料。请保留自己的判断，并在需要时要求它说明理由。",
  assistantName: "学习助理",
  welcome: "你好，有什么问题想和我讨论？",
  taskVisible: false,
  chatEnabled: true,
};
