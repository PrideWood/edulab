export type Stratum = "高" | "中" | "低";
export type RosterInput = { className: string; fullName: string; score: number; stratum?: Stratum; agentId?: string };
export type RosterStudent = RosterInput & { stratum: Stratum; agentId: string };
export const STRATA: Stratum[] = ["高", "中", "低"];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Deterministic rank thirds; ties use the teacher's distinct participation name. */
export function allocateRoster(input: RosterInput[], agents: string[], manual = false): RosterStudent[] {
  if (agents.length < 2 || agents.length > 20 || new Set(agents).size !== agents.length) throw new Error("请选择 2–20 个不同智能体。");
  if (!input.length || input.length > 5000) throw new Error("名单需包含 1–5000 名学生。");
  const seen = new Set<string>();
  const rows = input.map(row => {
    const className = row.className.trim(), fullName = row.fullName.trim();
    const key = JSON.stringify([className, fullName]);
    if (!className || !fullName || className.length > 100 || fullName.length > 100) throw new Error("班级和参与姓名必填，且各不超过 100 字。");
    if (seen.has(key)) throw new Error("同一班级的参与姓名重复，请为重名学生增加数字后再导入。");
    seen.add(key);
    if (!Number.isFinite(row.score) || Math.abs(row.score) > 1e9) throw new Error("前测成绩必须是有效数值。");
    if (row.stratum && !STRATA.includes(row.stratum)) throw new Error("层级只允许高、中、低。");
    return { ...row, className, fullName };
  });
  const totals = agents.map(() => 0), sums = agents.map(() => 0);
  const result: RosterStudent[] = [];
  const classes = [...new Set(rows.map(row => row.className))].sort(compare);
  for (const className of classes) {
    const students = rows.filter(row => row.className === className).sort((a,b) => b.score-a.score || compare(a.fullName,b.fullName));
    const supplied = students.filter(row => row.stratum).length;
    if (supplied && supplied !== students.length) throw new Error("同一班级需全部提供层级，或全部留空由系统划层。");
    const layered = students.map((row,index) => ({...row,stratum:row.stratum ?? STRATA[Math.floor(index*3/students.length)]}));
    const classCounts = agents.map(() => 0);
    for (const stratum of STRATA) {
      const counts = agents.map(() => 0);
      for (const student of layered.filter(row => row.stratum === stratum)) {
        // Every complete round uses all agents. Ties favor a lower score sum,
        // then class/experiment remainder balance, and finally stable agent order.
        const index = manual ? agents.indexOf(student.agentId ?? "") : agents.map((_,i)=>i).sort((a,b) =>
          counts[a]-counts[b] || classCounts[a]-classCounts[b] || totals[a]-totals[b] || sums[a]-sums[b] || a-b)[0];
        if (index < 0) throw new Error("手动分配要求每名学生指定已选的智能体。");
        counts[index]++; classCounts[index]++; totals[index]++; sums[index]+=student.score;
        result.push({...student,agentId:agents[index]});
      }
    }
  }
  return result;
}

export function rosterStatistics(rows: RosterStudent[], agents: string[]) {
  return agents.map(agentId => {
    const students = rows.filter(row => row.agentId === agentId);
    const n = students.length, mean = n ? students.reduce((sum,row)=>sum+row.score,0)/n : null;
    return {agentId,n,mean,sd:n>1 ? Math.sqrt(students.reduce((sum,row)=>sum+(row.score-mean!)**2,0)/(n-1)) : null,
      min:n ? Math.min(...students.map(row=>row.score)) : null,max:n ? Math.max(...students.map(row=>row.score)) : null};
  });
}

/** Quoted CSV and tab-separated paste; headers are mandatory to avoid column guessing. */
export function parseRosterText(text: string): RosterInput[] {
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g,"\n");
  const separator = text.split("\n")[0].includes("\t") ? "\t" : ",";
  const records: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='"') { if (quoted && text[i+1]==='"') {cell+='"';i++;} else quoted=!quoted; }
    else if (!quoted && (c===separator || c==='\n')) { row.push(cell.trim());cell=""; if(c==='\n'){if(row.some(Boolean))records.push(row);row=[];} }
    else cell+=c;
  }
  if(quoted) throw new Error("CSV 引号未闭合。");
  row.push(cell.trim());if(row.some(Boolean))records.push(row);
  const header=records.shift() ?? [];
  const find=(names:string[])=>header.findIndex(value=>names.includes(value));
  const ci=find(["班级","className"]), ni=find(["参与姓名","姓名","fullName"]), si=find(["前测成绩","前测分数","成绩","score"]);
  const li=find(["层级","stratum"]), ai=header.includes("agentId") ? header.indexOf("agentId") : find(["智能体"]);
  if([ci,ni,si].some(index=>index<0)) throw new Error("表头必须包含：班级、参与姓名、前测成绩；可选：层级、智能体。");
  return records.map((cells,index)=>{
    if(!cells[si]?.trim()) throw new Error(`第 ${index+2} 行缺少前测成绩。`);
    return {className:cells[ci] ?? "",fullName:cells[ni] ?? "",score:Number(cells[si]),
      ...(li>=0 && cells[li] ? {stratum:cells[li] as Stratum}:{}),...(ai>=0 && cells[ai] ? {agentId:cells[ai]}:{})};
  });
}

export function rosterCsv(records: unknown[][]) {
  return "\uFEFF"+records.map(row=>row.map(value=>{
    let text=String(value ?? "");
    if(typeof value!=="number" && /^[=+\-@\t\r]/.test(text)) text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  }).join(",")).join("\r\n");
}
