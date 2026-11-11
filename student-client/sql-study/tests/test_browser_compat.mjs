import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const compat=await readFile(new URL('../web/compat.js',import.meta.url),'utf8');

test('legacy fallbacks generate secure UUIDs and preserve Enter validation and submit handlers',()=>{
 const actions=[];
 function Form(){}
 Form.prototype.appendChild=function(){actions.push('append');};
 const context=vm.createContext({window:{crypto:{getRandomValues:array=>webcrypto.getRandomValues(array)}},HTMLFormElement:Form,document:{createElement:()=>({click(){actions.push('validated-click');},remove(){actions.push('remove');}})}});
 vm.runInContext('delete Array.prototype.at;',context);
 vm.runInContext(compat,context);
 assert.equal(vm.runInContext('[10,20,30].at(-1)',context),30);
 assert.equal(vm.runInContext('[10].at(3)',context),undefined);
 const ids=vm.runInContext('Array.from({length:100},function(){return window.crypto.randomUUID();})',context);
 assert.equal(new Set(ids).size,100);
 for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 new Form().requestSubmit();
 assert.deepEqual(actions,['append','validated-click','remove']);
});

test('compatible bootstrap precedes application and selection styling does not require CSS has()',async()=>{
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 const css=await readFile(new URL('../web/style.css',import.meta.url),'utf8');
 const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
 assert.ok(html.indexOf('/compat.js')<html.indexOf('/app.js'));
 assert.match(css,/#app \.choice\.selected\{/);
 assert.doesNotMatch(css,/\.choice:has\(/);
 assert.match(app,/app.onchange=.*syncChoices/);
 assert.match(app,/syncChoices\(\);\$\('#nav-home'\)/);
});

test('Chrome69 bootstrap restores fromEntries without prototype mutation',()=>{function Form(){}const context=vm.createContext({window:{},HTMLFormElement:Form,document:{}});vm.runInContext('delete Object.fromEntries;',context);vm.runInContext(compat,context);assert.equal(vm.runInContext('Object.fromEntries([["score",1],["score",2]]).score',context),2);assert.equal(vm.runInContext('Object.prototype.hasOwnProperty.call(Object.fromEntries([["__proto__",7]]),"__proto__")',context),true);assert.equal(vm.runInContext('window.globalThis===window',context),true);});
test('entire packaged student script parses at ES2017 language level',async()=>{const {compileChrome69}=await import('../compile_browser.mjs');const script=compileChrome69(await readFile(new URL('../web/app.js',import.meta.url),'utf8'));assert.match(script,/Chrome 69, ES2017/);new vm.Script(script);});
