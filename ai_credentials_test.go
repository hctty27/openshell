package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hctty27/openshell/internal/store"
)

func TestAIStoredKeyReadForEachRequestAndRedactedOnError(t *testing.T) {
	v:=&vault{m:map[string]string{"ref":"first-secret"}}
	a:=&App{secrets:v}
	headers:=make(chan string,3)
	server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		h:=r.Header.Get("Authorization")
		headers<-h
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w,h)
	}))
	defer server.Close()
	provider:=store.AIProvider{BaseURL:server.URL,SecretRef:"ref"}
	for _,key:=range []string{"first-secret","second-secret"}{
		v.m["ref"]=key
		_,_,err:=a.requestStoredAICompletion(context.Background(),provider,"model",nil,nil,func(string){})
		if err==nil||strings.Contains(err.Error(),key)||!strings.Contains(err.Error(),"[REDACTED]"){t.Fatal("provider error did not redact its credential")}
		if got:=<-headers;got!="Bearer "+key{t.Fatal("provider request used stale credential")}
	}
	delete(v.m,"ref")
	if _,_,err:=a.requestStoredAICompletion(context.Background(),provider,"model",nil,nil,func(string){});err==nil{t.Fatal("removed credential was still accepted")}
	select{case <-headers:t.Fatal("request sent without key");default:}
}

func TestAIProviderCheckRedactsEchoedKey(t *testing.T){
	key:="example-sensitive-key"
	server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w,r.Header.Get("Authorization"))
	}))
	defer server.Close()
	_,err:=checkAIProvider(context.Background(),server.URL,key,"model")
	if err==nil||strings.Contains(err.Error(),key)||!strings.Contains(err.Error(),"[REDACTED]"){t.Fatal("connection check leaked credential")}
}
