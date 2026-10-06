import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const prefix='claude-plugin-test-report ';
function readReport(result,file) {
  if(result.error || result.signal || result.status!==0) return undefined;
  const lines=(result.stdout ?? '').split(/\r?\n/).filter(line=>line.startsWith(prefix));
  if(lines.length!==1) return undefined;
  try {
    const report=JSON.parse(lines[0].slice(prefix.length));
    if(report.file!==file || !Array.isArray(report.results) || !report.results.length) return undefined;
    if(!report.results.every(item=>item && typeof item.title==='string' && Object.hasOwn(item,'failure') && item.failure===null)) return undefined;
    return report;
  } catch {return undefined;}
}
export function evaluateChildResult(result,file) {return !!readReport(result,file);}
function testFiles(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?testFiles(path):entry.isFile() && /\.test\.tsx?$/.test(entry.name)?[path]:[];
  }).sort();
}
export function runEngine(root) {
  const files=testFiles(join(root,'tests'));
  if(!files.length) {console.error('No engine test files found');return 1;}
  const env={...process.env,KATA_HOME:mkdtempSync(join(process.env.KATA_TEST_ROOT || tmpdir(),'kata-engine-tests-'))};
  for(const key of ['KATA_SERVER','KATA_DAEMON','KATA_AUTH_TOKEN','KATA_REF','KATA_TEAMMATE','KATA_INBOX_USER','KATA_SESSION_ID']) delete env[key];
  console.log(`Engine tests: ${files.length} files sequentially; isolated KATA_HOME=${env.KATA_HOME}`);
  let passed=0,failed=0;
  for(const file of files) {
    const result=spawnSync('claude',['plugin','test','--file',file,root],{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024});
    const report=readReport(result,file);
    if(!report) {
      failed++;
      console.error(`FAIL ${file}: unsuccessful child or missing, malformed, or failed native report`);
      if(result.error) console.error(result.error.message);
      if(result.stdout) console.error(result.stdout);
      if(result.stderr) console.error(result.stderr);
      continue;
    }
    passed+=report.results.length;
    console.log(`PASS ${file}: ${report.results.length} tests`);
  }
  console.log(`Engine: ${passed} tests passed; ${failed} files failed`);
  return failed?1:0;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=runEngine(dirname(dirname(fileURLToPath(import.meta.url))));
