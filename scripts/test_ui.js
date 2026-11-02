async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const checks = [];
  const original = window.lithe;
  const sample = {status:200,statusText:"OK",version:"HTTP/1.1",headers:[["content-type","application/json"]],body:'{"ok":true}',size:11,totalMs:12,truncated:false};
  let calls = [], pending;
  window.lithe = {context:{locale:"en"}, request:async (method,args) => {
    calls.push([method,args]);
    if (method === "functions.cancel") { pending?.({value:sample}); return {}; }
    if (args.function === "requests.parse") return {value:{requests:[{index:0,method:"GET",url:"http://example.invalid"}]}};
    return {value:sample};
  }};
  try {
    source.value="GET http://example.invalid"; source.dispatchEvent(new Event("input"));
    await run(true);
    assert(calls.map(x=>x[1].function).join() === "requests.parse,requests.execute", "Send must parse before executing");
    assert(response.value.includes('\n  "ok": true'), "Pretty JSON missing"); checks.push("parse-send-format");
    $("headers-tab").click(); assert(response.value.includes("content-type: application/json"), "Headers missing");
    $("body-tab").click(); $("pretty").checked=false; $("pretty").dispatchEvent(new Event("change"));
    assert(response.value === sample.body, "Raw body changed"); checks.push("headers-raw");
    sample.body='<img src=x onerror="window.injected=true">';
    await run(true); assert(!window.injected && response.value === sample.body, "HTML must stay text"); checks.push("text-only-response");
    sample.truncated=true; await run(true); assert(!$("notice").hidden && $("pretty").disabled, "Truncated preview not marked"); checks.push("truncation");
    source.value="GET http://example.invalid/changed"; source.dispatchEvent(new Event("input"));
    assert(!requests.options.length, "Stale selection retained"); await run(true);
    assert(calls.at(-2)[1].function === "requests.parse", "Edited text was not reparsed"); checks.push("stale-selection");
    window.lithe.request = async (method,args) => {
      if (method === "functions.cancel") { pending({value:sample}); return {}; }
      return new Promise(resolve => { pending=resolve; });
    };
    const running=run(true); assert(source.disabled && !cancel.disabled, "Busy controls incorrect");
    cancel.click(); await running;
    assert(!source.disabled && response.value === "" && $("status").textContent===t("cancelled"), "Late cancelled response displayed"); checks.push("cancel-late-result");
    window.lithe.request = async () => { throw {pluginErrorCode:"httpClient.transportFailed"}; };
    await run(true); assert($("status").textContent===t("httpClient.transportFailed") && !send.disabled, "Error recovery incorrect"); checks.push("error-recovery");
    return {passed: checks};
  } finally { window.lithe=original; busy=false; active=null; cancelled=false; controls(); }
}
