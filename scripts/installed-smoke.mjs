import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { backend } from '../tests/helpers.mjs';
import assert from 'node:assert/strict';
const upstream=await backend();
const docker=process.env.MCP_INSTALL_TARGET==='docker';
const command=docker?'docker':process.execPath;
const args=docker?['run','--rm','-i','--network','host','-e',`ALPHAPILOT_BASE_URL=${upstream.url}`,'-e','ALPHAPILOT_RESEARCH_TOKEN=backend-test','alphapilot-mcp:0.1.0','serve','--transport','stdio']:[process.env.MCP_INSTALLED_CLI,'serve'];
if (!docker && !process.env.MCP_INSTALLED_CLI) throw new Error("MCP_INSTALLED_CLI must point to the independently installed CLI");
const client=new Client({name:'installed-smoke',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
try {
 await client.connect(new StdioClientTransport({command,args,env:{PATH:process.env.PATH,ALPHAPILOT_BASE_URL:upstream.url,ALPHAPILOT_RESEARCH_TOKEN:'backend-test'},stderr:'pipe'}));
 const listed=await client.listTools();assert.ok(listed.tools.length>=40);
 for(const [name,args] of [['get_capabilities',{}],['validate_factors',{expressions:['invalid()']}],['submit_factor_backtest',{dataset_id:'test',factor_source:{type:'inline',factors:[{name:'close',expression:'$close'}]},idempotency_key:'installed-test'}],['get_job',{job_id:'job-1'}],['cancel_job',{job_id:'job-1'}]]) {
  const result=await client.callTool({name,arguments:args});assert.equal(result.isError,false,JSON.stringify(result));
 }
 assert.equal([...upstream.jobs.values()][0].job.status,'cancelled');
 console.log(JSON.stringify({target:docker?'docker':'npm-tarball',status:'passed',tool_count:listed.tools.length}));
} finally {await client.close();await upstream.close();}
