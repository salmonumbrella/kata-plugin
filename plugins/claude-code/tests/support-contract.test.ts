import { test, expect } from "claude-code/testing";
import { harness } from "./support.ts";

for(const mode of ["done","wontfix"] as const)test(`fake Kata rejects short normalized ${mode} messages`,async($,on)=>{
 const h=harness(on);const d=JSON.parse((await h.kata(["kata","create","C"])).stdout);const r=await h.kata(["kata","close",d.issue.short_id,"--"+mode,"--message","x"+" ".repeat(100),...(mode==="done" ? ["--test","pytest"] : [])]);expect(r.exitCode).not.toBe(0);
});

const body="Verified the isolated fixture and checked all required behavior with its own test evidence.";

test("fake Kata refuses done without evidence and a parent with open children",async($,on)=>{
 const h=harness(on);await h.kata(["kata","create","P"]);await h.kata(["kata","create","C","--parent","fixture#c1"]);
 expect((await h.kata(["kata","close","c2","--done","--message",body])).exitCode).not.toBe(0);
 expect((await h.kata(["kata","close","c1","--done","--message",body,"--test","pytest"])).exitCode).not.toBe(0);
});

test("fake Kata rejects repeated sibling messages and fourth close in a minute",async($,on)=>{
 const h=harness(on);await h.kata(["kata","create","P"]);for(let i=0;i<5;i++)await h.kata(["kata","create","C","--parent","fixture#c1"]);
 const close=(ref:string,message:string)=>h.kata(["kata","close",ref,"--done","--message",message,"--test","pytest"]);
 expect((await close("c2",body)).exitCode).toBe(0);expect((await close("c3",body.toUpperCase())).exitCode).not.toBe(0);
 expect((await close("c3",body+" child three")).exitCode).toBe(0);expect((await close("c4",body+" child four")).exitCode).toBe(0);expect((await close("c5",body+" child five")).exitCode).not.toBe(0);
});

test("fake Kata accepts the real --reviewed evidence alias",async($,on)=>{
 const h=harness(on);await h.kata(["kata","create","Alias"]);
 expect((await h.kata(["kata","close","c1","--done","--message",body,"--reviewed","source.py"])).exitCode).toBe(0);
});
