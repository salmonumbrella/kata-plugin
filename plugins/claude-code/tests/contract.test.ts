import { test, expect } from "claude-code/testing";
import { harness, start, spawn, canonicalContract } from "./support.ts";

test("canonical contract is fetched once, injected verbatim before the binding and original task", async($,on)=>{
 const h=harness(on); const prompts:string[]=[]; let n=0;
 on("agent.spawn",(_$,e)=>{prompts.push(e.prompt);return {model:"sonnet",agentId:"a"+ ++n};});
 await $.session.start(start); await $.agent.spawn(spawn()); await $.agent.spawn(spawn({tool_use_id:"t2"}));
 expect(h.contractCalls.length).toBe(1);
 for(const prompt of prompts){expect(prompt.startsWith(canonicalContract+"\n\nKata: your work is tracked as ")).toBe(true);expect(prompt.endsWith("\n\nOriginal")).toBe(true);}
 expect(prompts[0]).toContain("under fixture#root"); expect(prompts[0]).toContain("do not create another issue for it");
});

test("contract cache refreshes at session start and failure injects nothing", async($,on)=>{
 const h=harness(on); const prompts:string[]=[]; on("agent.spawn",(_$,e)=>{prompts.push(e.prompt);return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start); h.control.contract="NEW_CANONICAL\nverbatim";
 await $.session.start(start); await $.agent.spawn(spawn()); expect(prompts[0]).toContain("NEW_CANONICAL\nverbatim");
 h.control.contractFailure=true; await $.session.start(start); await $.agent.spawn(spawn({tool_use_id:"t2"})); expect(prompts[1]).toBe("Original");
 // Startup miss plus the spawn-budget recovery attempt both failed.
 expect(h.contractCalls.length).toBe(4);
});

test("main compose is unchanged and never receives the cached contract", async($,on)=>{
 const h=harness(on); on("prompt.compose",()=>({sections:[{id:"main-settings-contract",scope:"session",text:"existing main contract"}]}));
 await $.session.start(start);
 const r=await $.prompt.compose({model:"sonnet",promptModel:"sonnet",surfaces:[],tools:[],outputStyle:null,traits:[]});
 expect(r.sections).toEqual([{id:"main-settings-contract",scope:"session",text:"existing main contract"}]);
 expect(h.contractCalls.length).toBe(1);
});

test("delegate binding gives an explicit own close command with real evidence and failure instructions",async($,on)=>{
 const h=harness(on);let prompt="";
 on("agent.spawn",(_$,e)=>{prompt=e.prompt;return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start);await $.agent.spawn(spawn());
 const entry=h.persisted.get("session/s1/spawn/tool-1") as {teammate:string};
 expect(prompt.startsWith(canonicalContract+"\n\n")).toBe(true);
 expect(prompt).toContain(`close it yourself: \`kata --teammate ${entry.teammate} close fixture#c1 --done --message`);
 expect(prompt).toContain('--commit <sha> --test "<command>"');
 expect(prompt).toContain("use only the evidence you actually have");
 expect(prompt).toContain("If you could not verify it, do not close it; comment what remains.");
 expect(prompt.endsWith("\n\nOriginal")).toBe(true);
});

test("spawn recovers a canonical contract that missed the tight startup deadline",async($,on)=>{
 const h=harness(on,"");let prompt="";on("agent.spawn",(_$,e)=>{prompt=e.prompt;return {model:"sonnet",agentId:"a1"};});
 h.control.processDelayMs=350;let startupDone=false;const startup=$.session.start(start).then(()=>{startupDone=true;});await h.clock.advance(300);expect(startupDone).toBe(true);if(startupDone)await startup;
 let done=false;const work=$.agent.spawn(spawn()).then(()=>{done=true;});await h.clock.advance(3000);expect(done).toBe(true);if(done)await work;
 expect(prompt.startsWith(canonicalContract+"\n\nKata: your work is tracked as fixture#c2 under fixture#c1.")).toBe(true);
});
