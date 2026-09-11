'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),home=fs.mkdtempSync(path.join(root,'.tmp/codex-web-image-catalog-'));
const {nativeArgs,privateNativeEnv,resolveNativeBinary}=require('../../backend/codexWebNative.cjs');
const source=JSON.parse(fs.readFileSync(path.join(root,'vendor/codex-official/codex-rs/models-manager/models.json'),'utf8'));
const template=(source.models||source).find(model=>model.visibility==='list'),model='chatgpt-web/catalog-fixture',catalog=path.join(home,'catalog.json');
fs.writeFileSync(catalog,JSON.stringify({models:[{...template,slug:model,display_name:'Fixture',supported_in_api:true}]}));
fs.writeFileSync(path.join(home,'config.toml'),'[features]\napps = false\nplugins = false\n');
function declared(tools,result=[]){for(const tool of tools||[]){if(tool.type==='namespace'){for(const child of tool.tools||[])result.push({name:tool.name+'__'+child.name,deferred:tool.defer_loading===true||child.defer_loading===true});}else result.push({name:tool.name||tool.type,deferred:tool.defer_loading===true});}return result;}
(async()=>{let inventory,requestBody;const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;if(req.url.endsWith('/responses')){requestBody=JSON.parse(text);inventory=declared(requestBody.tools);}res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:'Offline catalog captured; no inference.'}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{const bundle=path.join(root,'vendor/codex-web/runtime'),state={route:`http://127.0.0.1:${server.address().port}/v1`,catalogPath:catalog,model,imageTool:{command:path.join(bundle,'runtime/bun.exe'),entry:path.join(bundle,'app/cli.js'),home:path.join(home,'bridge'),codeMode:{enabled:false,direct_only_tool_namespaces:['mcp__existing']}}};
const args=nativeArgs(state,['exec','--json','--skip-git-repo-check','-c','cli_auth_credentials_store="ephemeral"','hello']);
const child=spawn(resolveNativeBinary({root}),args,{cwd:home,env:privateNativeEnv({...process.env,CODEX_HOME:home}),windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();let errors='';child.stderr.on('data',data=>errors=(errors+data).slice(-1500));const timeout=setTimeout(()=>child.kill(),20000);await new Promise(r=>child.once('exit',r));clearTimeout(timeout);child.stdout.destroy();child.stderr.destroy();
assert(inventory,'Native Codex did not send a model request: '+errors);const image=inventory.find(tool=>tool.name.endsWith('lina_images__generate_image'));assert(image,'Image tool is missing from the initial native model request');assert.equal(image.deferred,false,'Image generation must not depend on tool_search');
// Read the native freeform format through the actual patched parser, including
// any Responses namespace/schema normalization. No model or account is used.
const requestFile=path.join(home,'request.json');fs.writeFileSync(requestFile,JSON.stringify(requestBody));
const sourceRoot=path.join(root,'.tmp/codex-web-build/source/src'),{pathToFileURL}=require('node:url');
const probe=`import {parseRequest} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'responses/parser.ts')).href)};import {toolContract} from ${JSON.stringify(pathToFileURL(path.join(sourceRoot,'lina-tool-relay.cjs')).href)};import fs from 'node:fs';import assert from 'node:assert/strict';const parsed=parseRequest(JSON.parse(fs.readFileSync(${JSON.stringify(requestFile)},'utf8')));const contract=toolContract(parsed);const tools=JSON.parse(contract[contract.indexOf('<native_codex_tool_inventory>')+1]);const patch=tools.find(t=>t.name==='apply_patch');assert.equal(patch?.format?.syntax,'lark');assert.match(patch.format.definition,/Update File/);assert.match(patch.format.definition,/Add File/);`;
require('node:child_process').execFileSync(state.imageTool.command,['-e',probe],{env:{...privateNativeEnv(process.env),LINA_CODEX_WEB_HOST_MODULE:'fixture'},windowsHide:true,stdio:'pipe'});
console.log(JSON.stringify({passed:true,initialImageTool:image,nativePatchGrammarPreserved:true,modelRequestsSentToWeb:0}));
}finally{server.close();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
