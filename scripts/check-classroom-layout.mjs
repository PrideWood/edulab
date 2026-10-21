// Run after npm run build. Uses an isolated headless browser and synthetic messages only.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory = await mkdtemp(path.join(tmpdir(), 'edulab-layout-'));
const chunks = '.next/static/chunks';
const files = (await readdir(chunks)).filter(file => file.endsWith('.css'));
const css = (await Promise.all(files.map(file => readFile(path.join(chunks, file), 'utf8')))).join('\n');
assert.match(css, /\.app-shell\{/);
// Simulate an old browser rejecting every declaration containing a dynamic viewport unit.
const legacyCss = css.replace(/(?:min-|max-)?height:[^;{}]*dvh[^;{}]*(?:;|(?=}))/g, '');
const markup = `<main class="app-shell chat-font-14"><section class="workspace conversation-workspace">
<aside class="conversation-sidebar"><div class="conversation-sidebar-head">EduLab</div><button class="new-conversation">开始新一次交互</button><nav class="conversation-list"></nav><button class="participant-profile-button">测试学生</button></aside>
<section class="chat-panel"><header class="chat-header"><div class="assistant-title"><div class="assistant-avatar">AI</div><div><p class="assistant-name">学习助手小睿</p><p class="assistant-status">正在思考…</p></div></div><div class="session-actions"><div class="font-size-controls"><button>A−</button><button>24px</button><button>A+</button></div><div class="export-actions"><button>下载全部交互记录</button><button>提交交互记录</button></div><span class="session-action-status" role="status">已下载 1 个会话，2 条消息。</span></div></header>
<div class="messages"><p class="day-label">开始于 12:42</p></div><div class="composer-wrap"><form class="composer"><textarea rows="1" aria-label="输入消息">继续讨论食品保存方式</textarea><button class="send-button">↑</button></form><p class="composer-help"><span>按 Enter 发送 · Shift + Enter 换行</span><span>0 / 2000 字</span></p><p class="draft-status">草稿已保存</p></div></section></section></main>`;
const check = `
const results=[];
const shell=document.querySelector('.app-shell'), workspace=document.querySelector('.workspace'), messages=document.querySelector('.messages'), composer=document.querySelector('.composer-wrap'), input=document.querySelector('textarea');
function rect(e){const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};}
function measure(stage){
 const w=rect(workspace), c=rect(composer), m=rect(messages), i=rect(input), s=rect(shell);
 results.push({stage,viewport:[innerWidth,innerHeight],shell:s,workspace:w,composer:c,messages:m,input:i,scrollHeight:messages.scrollHeight,clientHeight:messages.clientHeight,font:parseFloat(getComputedStyle(input).fontSize),bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,reachable:document.elementFromPoint(i.left+8,i.top+8)===input});
}
measure('empty');
const fontButton=rect(document.querySelector('.font-size-controls button')), downloadButton=rect(document.querySelector('.export-actions button'));
results[0].buttonAlignment={fontButton,downloadButton};
for(let n=0;n<200;n++){
 const row=document.createElement('div');row.className='message-row '+(n%2?'user':'assistant');
 row.innerHTML='<div class="message-stack"><div class="bubble markdown-content"><p>第 '+n+' 条消息：'+ '食品需要采用适当的保存方式，注意温度和储存时间。'.repeat(6)+'</p><pre><code>'+ 'long_unbroken_code_'.repeat(100)+'</code></pre></div><div class="message-time">12:49</div></div>';
 messages.append(row);
 const item=document.createElement('button');item.className='conversation-item';item.textContent='历史会话 '+n;document.querySelector('.conversation-list').append(item);
}
measure('200-messages');
shell.className='app-shell chat-font-24';measure('font-24');
const last=messages.lastElementChild.querySelector('.bubble');last.append(document.createTextNode('流式追加内容'.repeat(1000)));measure('streaming');
messages.scrollTop=messages.scrollHeight;
const final=rect(messages.lastElementChild);measure('scrolled-bottom');
results[results.length-1].lastBottom=final.bottom;
const output=document.createElement('script');output.id='layout-results';output.type='application/json';output.textContent=JSON.stringify(results);document.body.append(output);
`;
for (const legacy of [false, true]) {
  for (const [width,height] of [[1366,768],[1024,768],[800,600],[520,740]]) {
    const name = `${legacy ? 'legacy' : 'modern'}-${width}x${height}`;
    const fixture=path.join(directory,`${name}.html`);
    await writeFile(fixture,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${legacy ? legacyCss : css}</style><body>${markup}<script>${check}</script></body></html>`);
    const result=spawnSync(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${directory}/chrome`,`--window-size=${width},${height}`,...(name==='legacy-1366x768'?[`--screenshot=${directory}/long-chat.png`]:[]),'--dump-dom',pathToFileURL(fixture).href],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr);
    const raw=result.stdout.match(/<script id="layout-results" type="application\/json">(.*?)<\/script>/s)?.[1];
    assert.ok(raw,`${name}: browser did not return layout measurements`);
    const stages=JSON.parse(raw);
    for (const row of stages) {
      const context=`${name}/${row.stage}: ${JSON.stringify(row)}`;
      if(row.buttonAlignment){
        const {fontButton,downloadButton}=row.buttonAlignment;
        assert.equal(fontButton.height,downloadButton.height,context);
        if(width>=800) assert.equal(fontButton.top,downloadButton.top,context);
      }
      assert.equal(row.shell.height,row.viewport[1],context);
      assert.ok(row.workspace.bottom<=row.viewport[1] && row.workspace.top>=0,context);
      assert.ok(row.workspace.height>=row.viewport[1]-66,context);
      assert.ok(row.composer.bottom<=row.workspace.bottom && row.input.bottom<=row.composer.bottom,context);
      assert.ok(row.composer.top>=row.messages.bottom-1,context);
      assert.ok(row.messages.height>60,context);
      assert.ok(row.reachable,context);
      assert.ok(row.bodyWidth<=row.viewport[0] && row.bodyHeight<=row.viewport[1],context);
      assert.ok(Math.abs(row.composer.bottom-stages[0].composer.bottom)<1,context);
      if(row.stage!=='empty') assert.ok(row.scrollHeight>row.clientHeight,context);
      if(['font-24','streaming','scrolled-bottom'].includes(row.stage)) assert.equal(row.font,24,context);
      if(row.lastBottom) assert.ok(row.lastBottom<=row.messages.bottom+1,context);
    }
    console.log(`PASS ${name}: empty → 200 messages → 24px → streaming → scroll to last message`);
  }
}
console.log(`Layout fixtures and screenshot: ${directory}`);
