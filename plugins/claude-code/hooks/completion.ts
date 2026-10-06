import {documentationStatement, evidencePath, incompleteAnswer} from "./evidence.ts";

import type {WorkflowCompletion} from "../types/index.d.ts";
const list = (value: unknown): string[] => typeof value === "string" ? [value] :
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Only declarations of writing supply paths; examples and reviewed sources do not. */
function proseFiles(text: string): string[] {
  const paths: string[] = [];
  const path = /`([^`\n]+)`|((?:\/?[\w.@+-]+\/)*[\w@+-]+\.[\w-]+|README|REVIEW|LICENSE)/g;
  for (const clause of text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/\*\*/g, "").split(/\n|(?<=[.!?])\s+/)) {
    if (/^\s*>|\b(?:did not|didn't|never|another agent|someone else|the other agent)\b/i.test(clause)) continue;
    const write = /(?:\bI\b[^\n]*?\b(?:wrote|created|updated|saved|added)|^\s*(?:Wrote|Created|Updated|Written|Saved)(?: files?)?:?)\s+/i.exec(clause);
    if (!write) continue;
    const tail = clause.slice(write.index + write[0].length);
    const matches = [...tail.matchAll(path)];
    // An explicit writer with no attributable path is still a contributor.
    if (!matches.length) {paths.push("");continue;}
    // In “a review of source.py in REVIEW.md”, the source is not an output.
    let first = 0;
    if (/\b(?:of|for|about|on)\s*$/.test(tail.slice(0,matches[0]!.index))) {
      first=matches.findIndex(m=>/\b(?:in|to|as)\s*$/.test(tail.slice(0,m.index)));
      if(first<0){paths.push("");continue;}
    }
    paths.push(matches[first]![1] ?? matches[first]![2]!);
    let end = matches[first]!.index! + matches[first]![0].length;
    for (const next of matches.slice(first+1)) {
      if (!/^\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)$/.test(tail.slice(end,next.index))) break;
      paths.push(next[1] ?? next[2]!); end = next.index! + next[0].length;
    }
  }
  return paths;
}

/** Trust each contributor's result, without reading files or reconstructing tools. */
export function workflowCompletion(raw: string, cwd: string): WorkflowCompletion {
  const files = new Set<string>(), statements: string[] = [];
  const unverified = (text: string) => {
    const normalized = text.replace(/[,\s\u0085]+/g," ");
    return incompleteAnswer(normalized) ||
      /\b(?:unverified|not reviewed|not checked|not tested|not validated)\b/i.test(normalized) ||
      /(?<!\bno )\b(?:review|validation|(?:test|check) suite) (?:has |have |still |are |is )?(?:failed|failing)\b/i.test(normalized) ||
      /\bnot (?:all|every|each) (?:the )?(?:tests?|checks?|outputs?|results?|examples?) (?:pass(?:ed)?|match(?:ed)?)\b/i.test(normalized) ||
      /\b(?:did not|didn't|have not|haven't|could not|couldn't|cannot|can't|unable to|never|not yet)\s+(?:\w+\s+){0,2}(?:check(?:ed)?|verif(?:y|ied)|validat(?:e|ed)|test(?:ed)?|review(?:ed)?|pass(?:ed)?|run (?:the |any |all )?(?:tests?|checks?|examples?|repros?))\b/i.test(normalized);
  };
  let valid = !unverified(raw), writers = 0, nodes = 0;
  const writer = (paths: string[], statement: string | undefined) => {
    if (!paths.length) return;
    writers++;
    if (!statement) valid = false; else statements.push(statement);
    for (const path of paths) {
      if (!path.trim() || /[\x00-\x1f]/.test(path)) {valid=false;continue;}
      const relative = evidencePath(path,cwd);
      if (relative && !relative.startsWith("/") && relative !== ".") files.add(relative);
    }
  };
  const walk = (value: unknown, depth = 0, contributor = true): void => {
    if (++nodes > 10000 || depth > 32) {valid=false;return;}
    if (typeof value === "string") {
      try {const decoded:unknown=JSON.parse(value); if (decoded !== value) {walk(decoded,depth+1,contributor);return;}} catch {}
      if (unverified(value)) valid=false;
      if (contributor) writer(proseFiles(value),documentationStatement(value));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {for (const child of value) walk(child,depth+1,contributor);return;}
    const item=value as Record<string,unknown>;
    if (item.verified === false || item.incomplete === true || item.failed === true || item.success === false || (item.error !== undefined && item.error !== null && item.error !== false && item.error !== "") ||
        ["failed","killed","incomplete","error"].includes(String(item.status ?? ""))) valid=false;
    const declared=item.files ?? item.written ?? item.paths ?? item.file;
    if(declared !== undefined && !(typeof declared === "string" || (Array.isArray(declared) && declared.every(p=>typeof p === "string"))))valid=false;
    const paths=list(declared);
    if (paths.length) {
      const nestedResult = (key: string) => ["result","results","response","outputs","contributors","agents"].includes(key);
      const encodedObject = (value: unknown) => {
        if(typeof value!=="string")return false;
        try {const decoded:unknown=JSON.parse(value);return !!decoded && typeof decoded==="object";}catch{return false;}
      };
      const own=Object.entries(item).filter(([k,v])=>typeof v === "string" && !["file","files","written","paths"].includes(k) && !nestedResult(k) && !encodedObject(v)).map(([,v])=>v).join("\n");
      if (contributor) writer(paths,item.verified === true ? JSON.stringify(item).slice(0,1000) : documentationStatement(own));
      // A leaf's own strings belong to it; nested contributors remain independent.
      for (const [key,child] of Object.entries(item)) if (!["file","files","written","paths"].includes(key)) {
        if (child && typeof child === "object") walk(child,depth+1,contributor);
        // Decode and veto all own text without treating it as another writer.
        else if (typeof child === "string") walk(child,depth+1,contributor && (nestedResult(key) || encodedObject(child)));
      }
    } else for (const child of Object.values(item)) walk(child,depth+1,contributor);
  };
  try {walk(JSON.parse(raw));} catch {walk(raw);}
  return {verified: valid && writers > 0 && files.size > 0, files:[...files], statements};
}

export function workflowEvidenceArgs(proof: WorkflowCompletion | undefined): string[] {
  return proof?.verified ? proof.files.flatMap(file=>["--reviewed",file]) : [];
}

/** Preserve Kata's typed evidence, including evidence that has no shell analogue. */
export function closeEvidenceArgs(items: unknown[]): string[] {
  const pairs = new Map<string,string[]>();
  const add = (flag: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Malformed Kata close evidence");
    pairs.set(JSON.stringify([flag,value]),[flag,value]);
  };
  for (const value of items) {
    if (!value || typeof value !== "object") throw new Error("Malformed Kata close evidence");
    const item=value as Record<string,unknown>;
    switch (item.type) {
      case "commit": add("--commit",item.sha);break;
      case "pr": add("--pr",item.url);break;
      case "test": add("--test",item.command);break;
      case "external": if(typeof item.account!=="string" || !item.account.trim())throw new Error("Malformed Kata external evidence");add("--evidence","external:"+item.account);break;
      case "reviewed-paths": if(!Array.isArray(item.paths))throw new Error("Malformed Kata reviewed paths");for(const path of item.paths)add("--reviewed",path);break;
    }
  }
  return [...pairs.values()].flat();
}
