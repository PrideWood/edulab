import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const sources=new Map(await Promise.all(['app/roster/[token]/page.tsx','app/join/[token]/page.tsx'].map(async file=>[file,
  ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText])));
function page(file,mode) {
  const exports={};
  const modules={
    'react/jsx-runtime':jsx,
    'next/navigation':{notFound:()=>{throw new Error('NOT_FOUND');},redirect:path=>{throw new Error(`REDIRECT:${path}`);}},
    '@/app/workspace':{ExperimentWorkspace:()=>null},
    '@/lib/experiment-entry':{getExperimentEntry:async()=>({token:'abcd',runId:'run',experimentId:'project',assignmentMode:mode,snapshot:{experiment:{id:'project',title:'共同任务'}}})},
    '@/lib/session':{getAuthenticatedSession:async()=>null},
    '@/lib/experiment-settings':{getExperimentSettings:async()=>{throw new Error('should use entry snapshot');}},
    '@/lib/roster':{rosterClasses:async()=>['一班','二班']},
    '@/lib/http':{ApiError:class extends Error{}},
  };
  vm.runInNewContext(sources.get(file),{exports,require:name=>{assert.ok(name in modules,name);return modules[name];}});
  return exports.default({params:Promise.resolve({token:'ABCD'})});
}
test('roster page passes only class choices and common configuration to the student workspace',async()=>{
  const rendered=await page('app/roster/[token]/page.tsx','roster');
  assert.deepEqual(Object.keys(rendered.props).sort(),['entryToken','experiment','rosterClasses']);
  assert.equal(rendered.props.entryToken,'abcd');
  assert.deepEqual(Array.from(rendered.props.rosterClasses),['一班','二班']);
});
test('old and new route namespaces cannot accidentally turn a roster into unrestricted registration',async()=>{
  await assert.rejects(()=>page('app/join/[token]/page.tsx','roster'),/REDIRECT:\/roster\/abcd/);
  for(const mode of ['fixed','balanced_random']) {
    await assert.rejects(()=>page('app/roster/[token]/page.tsx',mode),/NOT_FOUND/);
    const rendered=await page('app/join/[token]/page.tsx',mode);
    assert.equal(rendered.props.rosterClasses,undefined);
  }
});
