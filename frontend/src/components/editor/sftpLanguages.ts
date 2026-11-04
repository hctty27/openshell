import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

export const sftpLanguages = [
  LanguageDescription.of({name:"JSON",extensions:["json","jsonc"],load:()=>import("@codemirror/lang-json").then(m=>m.json())}),
  LanguageDescription.of({name:"YAML",extensions:["yaml","yml"],load:()=>import("@codemirror/lang-yaml").then(m=>m.yaml())}),
  LanguageDescription.of({name:"JavaScript",extensions:["js","mjs","cjs"],load:()=>import("@codemirror/lang-javascript").then(m=>m.javascript())}),
  LanguageDescription.of({name:"TypeScript",extensions:["ts","mts","cts","tsx"],load:()=>import("@codemirror/lang-javascript").then(m=>m.javascript({typescript:true,jsx:true}))}),
  LanguageDescription.of({name:"HTML",extensions:["html","htm"],load:()=>import("@codemirror/lang-html").then(m=>m.html())}),
  LanguageDescription.of({name:"XML",extensions:["xml","xsd","svg"],load:()=>import("@codemirror/lang-xml").then(m=>m.xml())}),
  LanguageDescription.of({name:"Go",extensions:["go"],load:()=>import("@codemirror/lang-go").then(m=>m.go())}),
  LanguageDescription.of({name:"Java",extensions:["java"],load:()=>import("@codemirror/lang-java").then(m=>m.java())}),
  LanguageDescription.of({name:"Python",extensions:["py","pyw"],load:()=>import("@codemirror/lang-python").then(m=>m.python())}),
  LanguageDescription.of({name:"SQL",extensions:["sql"],load:()=>import("@codemirror/lang-sql").then(m=>m.sql())}),
  LanguageDescription.of({name:"CSS",extensions:["css"],load:()=>import("@codemirror/lang-css").then(m=>m.css())}),
  LanguageDescription.of({name:"Shell",extensions:["sh","bash","zsh","ksh"],filename:/^(\.bashrc|\.profile|\.zshrc)$/,load:()=>import("@codemirror/legacy-modes/mode/shell").then(m=>new LanguageSupport(StreamLanguage.define(m.shell)))}),
  LanguageDescription.of({name:"Nginx",filename:/^(nginx\.conf|.*\.nginx)$/,load:()=>import("@codemirror/legacy-modes/mode/nginx").then(m=>new LanguageSupport(StreamLanguage.define(m.nginx)))}),
];
