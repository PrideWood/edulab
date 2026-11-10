import ts from 'typescript';import {parse} from 'acorn';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
export function compileChrome69(source){
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.None,removeComments:false},fileName:'app.js',reportDiagnostics:true});
 if(result.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('Student JavaScript compilation failed');
 // Chrome 69 supports this language level. Required later browser APIs live in compat.js.
 parse(result.outputText,{ecmaVersion:2017,sourceType:'script'});
 return '/* EduLab classroom build: Chrome 69, ES2017. */\n'+result.outputText;
}
if(process.argv[1]===fileURLToPath(import.meta.url))process.stdout.write(compileChrome69(await readFile(new URL('web/app.js',import.meta.url),'utf8')));
