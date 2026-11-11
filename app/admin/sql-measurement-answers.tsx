type Questionnaire={answers?:Array<number|null>;items?:string[]}|null|undefined;
export function SqlMeasurementAnswers({pretest,pre,post,isTest}:{pretest:{score:number}|null;pre:Questionnaire;post:Questionnaire;isTest:boolean}){
 return <details><summary>查看前测与问卷作答</summary>{isTest&&<p className="profile-hint">测试身份：测量可跳过，所填记录保留，不参与正式分组或样本统计。</p>}<p>基础前测：{pretest?`${pretest.score} 分`:'未填写'}</p><div className="sql-control-grid">{([['课前问卷',pre],['课后问卷',post]] as const).map(([title,q])=><section key={title}><h4>{title}</h4>{q?.answers?<table className="local-backup-table"><thead><tr><th>题目</th><th>作答</th></tr></thead><tbody>{q.answers.map((value,i)=><tr key={i}><td>{i+1}. {q.items?.[i]??`第${i+1}题`}</td><td>{value??'未答'}</td></tr>)}</tbody></table>:<p>未填写</p>}</section>)}</div></details>;
}
