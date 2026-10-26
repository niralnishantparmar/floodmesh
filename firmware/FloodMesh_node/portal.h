#pragma once

const char PAGE_HEAD[] = R"HTML(<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FloodMesh sensor setup</title><style>
body{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;margin:0;background:#fbf6ea;color:#0f2740}
header{background:#163e66;color:#fbf6ea;padding:16px 22px;display:flex;align-items:center;gap:10px;font:600 19px Georgia,serif}
header svg{width:28px;height:28px}
main{max-width:420px;margin:0 auto;padding:26px 22px 40px}
h1{font-size:23px;line-height:1.25;margin:0 0 10px}
p{line-height:1.55;color:#3e4a55;margin:0 0 12px}
label{display:block;font-weight:600;font-size:14px;margin:20px 0 6px}
select,input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #d8ccb2;border-radius:8px;background:#fff;color:#0f2740}
button{margin-top:24px;width:100%;font-size:16px;font-weight:600;padding:14px;border:0;border-radius:10px;background:#2f7fc1;color:#fff}
.code{font:600 36px ui-monospace,Menlo,monospace;letter-spacing:.1em;margin:14px 0 6px;padding:14px;text-align:center;background:#e3f1fb;border-radius:12px;color:#0f2740}
.small{font-size:13px;color:#6a747d}
a{color:#256aa3}
</style></head><body><header><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#fbf6ea"/><path d="M3.1 17.5 C 7 14.8, 10.5 14.8, 14.3 17.5 S 21.7 20.2, 25.5 17.5 C 26.6 16.7, 27.8 16.6, 28.9 17.5 A13 13 0 0 1 3.1 17.5 Z" fill="#2f7fc1"/><circle cx="16" cy="16" r="13" fill="none" stroke="#0f2740" stroke-width="2.6"/></svg>FloodMesh</header><main>)HTML";

const char PAGE_TAIL[] = "</main></body></html>";

const char STATUS_SCRIPT[] = R"HTML(<script>
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const poll = async () => {
  try{
    const j=await (await fetch('/status',{cache:'no-store'})).json();
    const m=document.getElementById('msg');
    if(j.state==='connected'){
      m.innerHTML='<h1>'+(j.paired?'All set':'Connected to '+esc(j.ssid))+'</h1>'+
        (j.paired?'<p>This sensor is paired with your FloodMesh account and is sending readings. You can close this page.</p>':
        '<p>Open FloodMesh, choose <strong>Add a sensor</strong>, and enter this pairing code:</p><div class="code">'+esc(j.code)+'</div><p class="small">Keep this page open until the app says the sensor is paired.</p>');
      if(j.paired)return;
    }else if(j.state==='failed'){
      m.innerHTML='<h1>That didn\'t work</h1><p>The sensor couldn\'t join '+esc(j.ssid)+'. Check the password, and make sure the network is 2.4 GHz, since the sensor can\'t see 5 GHz networks.</p><p><a href="/">Try again</a></p>';
      return;
    }
  }catch(e){}
  setTimeout(poll,2000);
};
poll();
</script>)HTML";

const char FORM_SCRIPT[] = R"HTML(<script>
const ssidSelect = document.getElementById('ssid');
const otherInput = document.getElementById('other');
const otherLabel = document.getElementById('otherLabel');
const toggleOther = () => {
  const show = ssidSelect.value === '__other';
  otherInput.style.display = show ? 'block' : 'none';
  otherLabel.style.display = show ? 'block' : 'none';
};
ssidSelect.onchange = toggleOther;
toggleOther();
</script>)HTML";
