package main

import (
	"path"
	"regexp"
	"strings"
)

var aiShellContentReaders = map[string]bool{
	"cat":true,"head":true,"tail":true,"wc":true,"grep":true,"egrep":true,"fgrep":true,
	"sort":true,"cut":true,"column":true,"nl":true,"uniq":true,"diff":true,"cmp":true,
	"comm":true,"strings":true,"sha256sum":true,"sha1sum":true,"sha512sum":true,"md5sum":true,"cksum":true,
}

var aiStdinCount = regexp.MustCompile(`^(-[0-9]+|-n[0-9]+|-c[0-9]+|--lines=[0-9]+|--bytes=[0-9]+)$`)
var aiGrepStdinFlags = regexp.MustCompile(`^-[ivEFncwxoqs]+$`)

// Shell syntax alone cannot prove the file actually opened by the remote
// process. Rather than guessing the cwd, following symlinks in a separate
// channel, or racing a realpath check against open(), require approval for
// file-content readers. Ordinary text files can use the SFTP path policy.
// Keep common inspection pipelines that consume only stdin quiet.
func aiShellFileAccessNeedsApproval(command string) bool {
	stages,ok:=aiShellSimpleParse(command)
	if !ok{return true}
	for i,words:=range stages {
		name:=path.Base(words[0])
		args:=words[1:]
		if aiShellContentReaders[name] {
			if i==0 || !aiShellStdinFilter(name,args) {return true}
		}
		switch name {
		case "file":
			// -f and --files-from open a list file; -m reads a magic file.
			if aiAnyShortFlags(args,"fm") || aiHasLongFlag(args,"--files-from","--magic-file"){return true}
		case "date":
			if aiAnyShortFlags(args,"f")||aiHasLongFlag(args,"--file"){return true}
		case "find":
			for _,a:=range args{if strings.HasPrefix(a,"-files0-from"){return true}}
		case "journalctl":
			if aiAnyShortFlags(args,"D")||aiHasLongFlag(args,"--file","--directory","--root","--image"){return true}
		case "git":
			if aiHasLongFlag(args,"--no-index"){return true}
		}
	}
	return false
}

func aiShellStdinFilter(name string,args []string) bool {
	switch name {
	case "cat","wc","sort","uniq":
		return len(args)==0
	case "head","tail":
		if len(args)==0{return true}
		if len(args)==1{return aiStdinCount.MatchString(args[0])}
		if len(args)==2&&(args[0]=="-n"||args[0]=="-c"){
			return regexp.MustCompile(`^[0-9]+$`).MatchString(args[1])
		}
	case "grep","egrep","fgrep":
		if len(args)==0{return false}
		for _,a:=range args[:len(args)-1]{if !aiGrepStdinFlags.MatchString(a){return false}}
		pattern:=args[len(args)-1]
		// Quoted and unquoted shell words are normalized by the parser;
		// expansion characters must not turn the pattern into file args.
		return pattern!=""&&!strings.HasPrefix(pattern,"-")&&!strings.ContainsAny(pattern,"*?[]~{}$"+string(rune(96)))
	}
	return false
}
