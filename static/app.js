(function() {
    'use strict';
    var type='video', quality='1080p', audioFmt=null, audioMode='video', subs=false, artFmt='pdf', poll=null;
    var projects=[], activeProject='all';
    var input=document.getElementById('urlInput');
    var debounce;

    var UI_ICONS={
        video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2 15 12l-5 2.8V9.2Z" fill="currentColor" stroke="none"/></svg>',
        audio:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17V5l10-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="16" cy="15" r="3"/></svg>',
        doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
        file:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>'
    };

    input.addEventListener('input', function(){clearTimeout(debounce);var u=input.value.trim();u.length>8?debounce=setTimeout(function(){det(u)},300):hideType()});
    input.addEventListener('keydown', function(e){if(e.key==='Enter')startDownload()});

    function det(u){
        u=u.toLowerCase();
        if(/^10\.\d{4,}/.test(u)||/doi\.org\/10\./.test(u)||/\/10\.\d{4,}\//.test(u))return showT('doi','doc','Academic Paper','DOI → open-access PDF');
        if(u.includes('arxiv.org'))return showT('arxiv','doc','arXiv Paper','Preprint');
        if(u.includes('pubmed')||u.includes('ncbi.nlm.nih.gov'))return showT('pubmed','doc','PubMed','Medical literature');
        if(/springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm/.test(u))return showT('academic','doc','Academic Article','Journal article');
        showT('video','video','Video','YouTube, Vimeo, TikTok + 1000 more');
    }

    function showT(t,icon,label,hint){
        type=t;document.getElementById('typeIcon').innerHTML=UI_ICONS[icon]||UI_ICONS.file;
        document.getElementById('typeLabel').textContent=label;
        document.getElementById('typeHint').textContent=hint;
        document.getElementById('typeBadge').classList.add('active');
        document.getElementById('optionsPanel').classList.add('active');
        document.getElementById('videoOptions').style.display=t==='video'?'block':'none';
        document.getElementById('articleOptions').style.display=t!=='video'?'block':'none';
    }

    function hideType(){document.getElementById('typeBadge').classList.remove('active');document.getElementById('optionsPanel').classList.remove('active');type='video'}

    // ── Rooms (multi-app switcher: Shrimp ⇄ Open Canvas Studio) ──────
    window.toggleRooms=function(e){if(e)e.stopPropagation();document.getElementById('roomsPanel').classList.toggle('open')};
    document.addEventListener('click',function(e){
        var p=document.getElementById('roomsPanel'),b=document.getElementById('roomsBtn');
        if(p&&p.classList.contains('open')&&!p.contains(e.target)&&b&&!b.contains(e.target))p.classList.remove('open');
    });

    window.pickQ=function(el){document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');quality=el.dataset.q};
    window.setMode=function(m){audioMode=m;document.querySelectorAll('.audio-toggle-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===m)});document.getElementById('audioFormats').classList.toggle('active',m==='audio');document.querySelectorAll('.quality-card').forEach(function(c){c.style.opacity=m==='audio'?'0.4':'1'});if(m==='audio'){quality='audio';document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')})}else{var d=document.querySelector('.quality-card[data-q="1080p"]');if(d){d.classList.add('selected');quality='1080p'}}};
    window.pickA=function(el){document.querySelectorAll('.audio-chip[data-fmt]').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');audioFmt=el.dataset.fmt};
    window.pickArt=function(el){document.querySelectorAll('#articleOptions .audio-chip').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');artFmt=el.dataset.fmt};
    window.togSub=function(){subs=!subs;document.getElementById('subToggle').classList.toggle('active',subs)};

    window.startDownload=function(){
        var url=input.value.trim();if(!url)return;
        var btn=document.getElementById('downloadBtn');
        btn.classList.add('loading');btn.disabled=true;
        document.getElementById('progressSection').classList.add('active');
        resetProg();showSt('loading','Resolving...');

        fetch('/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,type:type==='video'?'auto':type,quality:quality,format:audioMode==='audio'?(audioFmt||'mp3'):'mp4',subtitles:subs})})
        .then(function(res){return res.json()})
        .then(function(d){if(d.error)throw new Error(d.error);pollSt(d.download_id,d.type)})
        .catch(function(e){showSt('error',e.message||'Failed')})
        .finally(function(){btn.classList.remove('loading');btn.disabled=false});
    };

    function pollSt(id,dlType){
        var misses=0;
        poll=setInterval(function(){
            fetch('/api/status/'+encodeURIComponent(id))
            .then(function(r){return r.json()})
            .then(function(d){
                if(d.status==='error'){clearInterval(poll);showSt('error',d.message||d.error)}
                else if(d.status==='complete'){clearInterval(poll);updProg(d);setPh('ready');if(d.filename){showSt('success','Ready \u2014 saved to library');triggerDl(id)}else{showSt('success',d.message||'Found \u2014 no downloadable file available')}refreshLibIfOpen()}
                else if(d.status==='not_found'){if(++misses>8){clearInterval(poll);showSt('error','Download not found')}}
                else{misses=0;updProg(d);setPh(d.phase||d.status)}
            })
            .catch(function(){clearInterval(poll);showSt('error','Connection lost')});
        },700);
    }

    function updProg(d){
        var p=d.progress||'0';
        document.getElementById('progressFill').style.width=p+'%';
        document.getElementById('statProgress').textContent=p+'%';
        document.getElementById('statSpeed').textContent=d.speed||'\u2014';
        document.getElementById('statEta').textContent=d.eta||'\u2014';
        var l={starting:'Init',downloading:'Download',fetching:'Fetch',processing:'Process',encoding:'Encode',complete:'Done'};
        document.getElementById('statStatus').textContent=l[d.status]||d.status;

        if(d.type==='article'&&d.title){
            document.getElementById('paperInfo').classList.add('active');
            document.getElementById('paperTitle').textContent=d.title;
            document.getElementById('paperAuthors').textContent=(d.authors||[]).join(', ');
            document.getElementById('paperDoi').textContent=d.doi||'';
            document.getElementById('paperJournal').textContent=d.journal||'';
            document.getElementById('paperYear').textContent=d.year||'';
        }

        var st=d.status==='complete'?'success':'loading';
        showSt(st,d.message||'Working...');
    }

    function setPh(p){
        ['phase1','phase2','phase3'].forEach(function(id){document.getElementById(id).className='phase'});
        if(['init','starting','downloading','fetching'].indexOf(p)!==-1)document.getElementById('phase1').classList.add('active');
        else if(['processing','encoding'].indexOf(p)!==-1){document.getElementById('phase1').classList.add('done');document.getElementById('phase2').classList.add('active')}
        else if(['ready','complete'].indexOf(p)!==-1){document.getElementById('phase1').classList.add('done');document.getElementById('phase2').classList.add('done');document.getElementById('phase3').classList.add('active')}
    }

    function resetProg(){document.getElementById('progressFill').style.width='0%';document.getElementById('statProgress').textContent='0%';document.getElementById('statSpeed').textContent='\u2014';document.getElementById('statEta').textContent='\u2014';document.getElementById('statStatus').textContent='Waiting';document.getElementById('paperInfo').classList.remove('active');document.getElementById('statusBar').classList.remove('active');['phase1','phase2','phase3'].forEach(function(id){document.getElementById(id).className='phase'})}

    function showSt(t,msg){var b=document.getElementById('statusBar');b.className='status-bar active '+t;document.getElementById('statusMsg').textContent=msg}

    function triggerDl(id){var a=document.createElement('a');a.href='/api/stream/'+encodeURIComponent(id);a.style.display='none';document.body.appendChild(a);a.click();setTimeout(function(){a.remove()},1000)}

    // ── Library ──────────────────────────────────────────────────────
    var TYPE_ICON={video:UI_ICONS.video,article:UI_ICONS.doc};
    function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function fmtSize(b){b=Number(b)||0;if(!b)return'';var u=['B','KB','MB','GB','TB'],i=0;while(b>=1024&&i<u.length-1){b/=1024;i++}return b.toFixed(i?1:0)+' '+u[i]}
    function mainEls(){return[document.querySelector('.hero'),document.querySelector('.input-card'),document.getElementById('progressSection'),document.getElementById('features')]}

    function hideViews(){document.getElementById('libraryView').style.display='none';var rv=document.getElementById('reviewView');if(rv)rv.style.display='none'}
    window.showLibrary=function(){mainEls().forEach(function(e){if(e)e.style.display='none'});hideViews();document.getElementById('libraryView').style.display='block';window.scrollTo(0,0);loadDrive();loadProjects();loadLibrary('')};
    window.showMain=function(){hideViews();mainEls().forEach(function(e){if(e&&e.id!=='progressSection')e.style.display=''})};
    window.showReview=function(){mainEls().forEach(function(e){if(e)e.style.display='none'});hideViews();document.getElementById('reviewView').style.display='block';window.scrollTo(0,0);if(!document.querySelectorAll('#srConcepts .sr-concept').length){addConcept('Population / Phenomenon');addConcept('Intervention / Input');addConcept('Measure / Outcome')}var ew=document.getElementById('srExcludeWrap');if(ew&&!ew.querySelector('.sr-tags')){var c=tagsContainer([],'Exclude (NOT) — noise terms, press Enter');c.id='srExclude';ew.appendChild(c)}};

    function refreshLibIfOpen(){if(document.getElementById('libraryView').style.display==='block'){var s=document.getElementById('libSearch');loadLibrary(s?s.value.trim():'')}}

    function loadLibrary(q){
        var params=[];
        if(q)params.push('q='+encodeURIComponent(q));
        if(activeProject&&activeProject!=='all')params.push('project='+encodeURIComponent(activeProject));
        fetch('/api/library'+(params.length?('?'+params.join('&')):''))
        .then(function(r){return r.json()})
        .then(function(d){renderLib(d.resources||[])})
        .catch(function(){});
    }
    var libDebounce;
    window.searchLib=function(q){clearTimeout(libDebounce);libDebounce=setTimeout(function(){loadLibrary((q||'').trim())},250)};

    function renderLib(items){
        var grid=document.getElementById('libList'),empty=document.getElementById('libEmpty');
        if(!items.length){grid.innerHTML='';empty.style.display='block';return}
        empty.style.display='none';
        grid.innerHTML=items.map(function(it){
            var m=it.meta||{};
            var sub=[it.type,m.journal,m.year].filter(Boolean).join(' · ');
            var sz=fmtSize(it.size);
            return '<div class="lib-card">'+
                '<div class="lib-icon">'+(TYPE_ICON[it.type]||UI_ICONS.file)+'</div>'+
                '<div class="lib-body"><div class="lib-title">'+esc(it.title||it.filename||'Untitled')+'</div>'+
                '<div class="lib-sub">'+esc(sub)+(sz?(' · '+sz):'')+'</div></div>'+
                '<div class="lib-actions">'+
                projMoveSelect(it)+
                (it.type==='video'&&it.filename&&!it.has_text?('<button class="lib-btn lib-transcribe" data-id="'+esc(it.id)+'">Transcribe</button>'):'')+
                (it.filename?('<button class="lib-btn lib-ask" data-id="'+esc(it.id)+'" data-title="'+esc(it.title||it.filename||'')+'">Ask</button>'):'')+
                (it.filename?('<a class="lib-btn" href="/api/stream/'+encodeURIComponent(it.id)+'">Download</a>'):'')+
                (it.filename&&drive.connected?('<button class="lib-btn lib-drive" data-id="'+esc(it.id)+'">Drive</button>'):'')+
                '<button class="lib-btn lib-del" data-id="'+esc(it.id)+'">Delete</button>'+
                '</div></div>';
        }).join('');
        Array.prototype.forEach.call(grid.querySelectorAll('.lib-del'),function(b){b.onclick=function(){delRes(b.getAttribute('data-id'))}});
        Array.prototype.forEach.call(grid.querySelectorAll('.lib-drive'),function(b){b.onclick=function(){syncDrive(b.getAttribute('data-id'),b)}});
        Array.prototype.forEach.call(grid.querySelectorAll('.lib-ask'),function(b){b.onclick=function(){setAskScope(b.getAttribute('data-id'),b.getAttribute('data-title'))}});
        Array.prototype.forEach.call(grid.querySelectorAll('.lib-move'),function(s){s.onchange=function(){moveResource(s.getAttribute('data-id'),s.value)}});
        Array.prototype.forEach.call(grid.querySelectorAll('.lib-transcribe'),function(b){b.onclick=function(){transcribeRes(b.getAttribute('data-id'),b)}});
    }

    function transcribeRes(id,btn){
        if(btn){btn.disabled=true;btn.textContent='Transcribing…'}
        fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.error){if(btn){btn.disabled=false;btn.textContent='Transcribe'}var a=document.getElementById('askAnswer');if(a){a.style.display='block';a.className='ask-answer error';a.textContent=d.error}}
            else{refreshLibIfOpen()}
        })
        .catch(function(){if(btn){btn.disabled=false;btn.textContent='Transcribe'}});
    }

    function projMoveSelect(it){
        var opts='<option value="">Unfiled</option>'+projects.map(function(p){
            return '<option value="'+esc(p.id)+'"'+(it.project_id===p.id?' selected':'')+'>'+esc(p.name)+'</option>';
        }).join('');
        return '<select class="lib-move" data-id="'+esc(it.id)+'" title="Move to project">'+opts+'</select>';
    }
    function moveResource(id,pid){
        fetch('/api/resource/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,project:pid})})
        .then(function(r){return r.json()}).then(function(){loadProjects();refreshLibIfOpen()}).catch(function(){});
    }

    function delRes(id){
        fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
        .then(function(r){return r.json()})
        .then(function(){refreshLibIfOpen()})
        .catch(function(){});
    }

    // ── Google Drive ─────────────────────────────────────────────────
    var drive={configured:false,connected:false,email:null};
    function loadDrive(){
        return fetch('/api/auth/status').then(function(r){return r.json()})
        .then(function(d){drive=d;renderDriveBar()})
        .catch(function(){});
    }
    function renderDriveBar(){
        var bar=document.getElementById('driveBar');
        if(!drive.configured){bar.style.display='none';return}
        bar.style.display='flex';
        if(drive.connected){
            bar.innerHTML='<span class="drive-status"><span class="drive-dot on"></span>Drive connected'+(drive.email?(' · '+esc(drive.email)):'')+'</span>'+
                '<button class="drive-btn ghost" id="driveLogout">Disconnect</button>';
            document.getElementById('driveLogout').onclick=function(){
                fetch('/api/auth/logout',{method:'POST'}).then(function(){loadDrive().then(refreshLibIfOpen)})};
        }else{
            bar.innerHTML='<span class="drive-status"><span class="drive-dot"></span>Save your library to Google Drive</span>'+
                '<button class="drive-btn" onclick="window.connectDrive()">Connect Drive</button>';
        }
    }
    window.connectDrive=function(){window.location.href='/api/auth/google/start'};
    function syncDrive(id,btn){
        if(btn){btn.disabled=true;btn.textContent='…'}
        fetch('/api/drive/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
        .then(function(r){return r.json()})
        .then(function(d){if(btn){btn.disabled=false;btn.textContent=d.synced?'Saved':'Drive';if(d.error)btn.textContent='Failed'}})
        .catch(function(){if(btn){btn.disabled=false;btn.textContent='Failed'}});
    }

    // ── AI assistant ─────────────────────────────────────────────────
    var askScopeId=null;
    function setAskScope(id,title){
        askScopeId=id;
        var s=document.getElementById('askScope');
        s.style.display='flex';
        s.innerHTML='<span class="ask-scope-text">Asking about: '+esc(title||'this resource')+'</span><button class="ask-scope-x" id="askScopeX">×</button>';
        document.getElementById('askScopeX').onclick=clearAskScope;
        var inp=document.getElementById('askInput');inp.placeholder='Ask about this resource...';inp.focus();
        window.scrollTo({top:0,behavior:'smooth'});
    }
    function clearAskScope(){askScopeId=null;document.getElementById('askScope').style.display='none';document.getElementById('askInput').placeholder='Ask the AI about your library...'}

    window.askAI=function(){
        var inp=document.getElementById('askInput');var q=inp.value.trim();if(!q)return;
        var btn=document.getElementById('askBtn');var ans=document.getElementById('askAnswer');
        btn.disabled=true;btn.textContent='…';
        ans.style.display='block';ans.className='ask-answer loading';ans.textContent='Thinking…';
        var provider=document.getElementById('askProvider').value||undefined;
        var key=document.getElementById('askKey').value.trim();
        if(key)sessionStorage.setItem('rs_ai_key',key); else key=sessionStorage.getItem('rs_ai_key')||undefined;
        var body={question:q};
        if(askScopeId)body.id=askScopeId;
        else if(activeProject&&activeProject!=='all'&&activeProject!=='unfiled')body.project=activeProject;
        if(provider)body.provider=provider;
        if(key)body.key=key;
        fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()})
        .then(function(d){
            btn.disabled=false;btn.textContent='Ask';
            if(d.error){ans.className='ask-answer error';ans.textContent=d.error;return}
            ans.className='ask-answer';
            ans.innerHTML='<div class="ask-text"></div><div class="ask-model">'+esc((d.provider||'')+' · '+(d.model||''))+'</div>';
            ans.querySelector('.ask-text').textContent=d.answer||'(no answer)';
        })
        .catch(function(){btn.disabled=false;btn.textContent='Ask';ans.className='ask-answer error';ans.textContent='Request failed.'});
    };

    // ── Projects ─────────────────────────────────────────────────────
    function loadProjects(){
        return fetch('/api/projects').then(function(r){return r.json()})
        .then(function(d){projects=d.projects||[];renderProjBar()}).catch(function(){});
    }
    function renderProjBar(){
        var bar=document.getElementById('projBar');
        function chip(key,label,count){
            var on=activeProject===key;
            return '<button class="proj-chip'+(on?' on':'')+'" data-k="'+esc(key)+'">'+esc(label)+(count!=null?(' <span class="proj-count">'+count+'</span>'):'')+'</button>';
        }
        var html=chip('all','All')+chip('unfiled','Unfiled');
        html+=projects.map(function(p){return chip(p.id,p.name,p.count)}).join('');
        html+='<button class="proj-chip proj-new" id="projNew">+ New</button>';
        bar.innerHTML=html;
        Array.prototype.forEach.call(bar.querySelectorAll('.proj-chip[data-k]'),function(b){b.onclick=function(){selectProject(b.getAttribute('data-k'))}});
        var nb=document.getElementById('projNew'); if(nb)nb.onclick=newProject;
        // right-click a project chip to rename/delete
        Array.prototype.forEach.call(bar.querySelectorAll('.proj-chip[data-k]'),function(b){
            var k=b.getAttribute('data-k');
            if(k==='all'||k==='unfiled')return;
            b.oncontextmenu=function(e){e.preventDefault();projectMenu(k)};
        });
    }
    function selectProject(k){activeProject=k;renderProjBar();loadLibrary(libQuery())}
    function libQuery(){var s=document.getElementById('libSearch');return s?s.value.trim():''}
    function newProject(){
        var name=prompt('Project name:'); if(!name)return; name=name.trim(); if(!name)return;
        fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
        .then(function(r){return r.json()}).then(function(d){if(d.project){activeProject=d.project.id}loadProjects().then(function(){renderProjBar();loadLibrary('')})}).catch(function(){});
    }
    function projectMenu(id){
        var p=projects.filter(function(x){return x.id===id})[0]; if(!p)return;
        var act=prompt('Type "rename" or "delete" for project "'+p.name+'":'); if(!act)return;
        act=act.trim().toLowerCase();
        if(act==='delete'){
            fetch('/api/projects/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
            .then(function(){if(activeProject===id)activeProject='all';loadProjects().then(function(){loadLibrary('')})});
        }else if(act==='rename'){
            var nn=prompt('New name:',p.name); if(!nn)return;
            fetch('/api/projects/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,name:nn.trim()})})
            .then(function(){loadProjects()});
        }
    }

    // ── Settings (AI providers) ──────────────────────────────────────
    var PROVIDER_LABELS={openai:'OpenAI',anthropic:'Anthropic',groq:'Groq',openrouter:'OpenRouter',deepseek:'DeepSeek',custom:'Custom',ollama:'Ollama'};
    var PROVIDER_ICONS={
        openai:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1.5 0 2.9.8 3.6 2.1a4.1 4.1 0 0 1 2.9 6.8 4.1 4.1 0 0 1-3.6 6.9A4.1 4.1 0 0 1 12 19a4.1 4.1 0 0 1-2.9-1.2 4.1 4.1 0 0 1-3.6-6.9 4.1 4.1 0 0 1 2.9-6.8A4.1 4.1 0 0 1 12 2Zm0 4.6L8.9 8.4v3.5L12 13.7l3.1-1.8V8.4L12 6.6Z"/></svg>',
        anthropic:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.1 4h-2.6l4.7 16H20L15.1 4ZM7.1 4 2.3 20h2.7l1-3.5h4.5l1 3.5H14L9.2 4H7.1Zm-.4 10.2 1.5-5.3 1.5 5.3H6.7Z"/></svg>',
        deepseek:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.8 10.6c3.2-1.1 5.2 1.1 7.3 1.1 2 0 3.1-3 6.1-3 2.1 0 3.7 1.3 4.2 3.2-.7-.5-1.4-.6-2.1-.1.8.6 1.1 1.7.6 2.8-.5-.7-1.3-.9-2.1-.4.3.9 0 1.8-.9 2.3.1-1.1-.6-1.8-1.6-1.9-2.3-.2-3.2 1-5.4 1-3.2-.1-5.3-2-6.1-5Zm12.5-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg>',
        groq:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a7 7 0 1 0 2 13.7V14.5A4.8 4.8 0 1 1 16.8 12H19A7 7 0 0 0 12 3Zm0 4.2a4.8 4.8 0 0 0-.1 9.6V14.5a2.6 2.6 0 1 1 .1-5.1V7.2Z"/></svg>',
        openrouter:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.4"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3"/><circle cx="12" cy="3.2" r="1.3" fill="currentColor"/><circle cx="12" cy="20.8" r="1.3" fill="currentColor"/><circle cx="3.2" cy="12" r="1.3" fill="currentColor"/><circle cx="20.8" cy="12" r="1.3" fill="currentColor"/></svg>',
        ollama:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 3c-1 0-1.6 1-1.5 2.3C5.6 6.1 5 7.4 5 9.1c0 .6.1 1.1.3 1.6C4.5 11.4 4 12.5 4 14v4c0 1.1.9 2 2 2h1.5v-2H6v-4c0-1.1.7-1.9 1.4-2.2.5.2 1 .3 1.6.3h6c.6 0 1.1-.1 1.6-.3.7.3 1.4 1.1 1.4 2.2v4H18v2h2v-2-4c0-1.5-.5-2.6-1.3-3.3.2-.5.3-1 .3-1.6 0-1.7-.6-3-1.5-3.8C17.6 4 17 3 16 3c-.8 0-1.4.6-1.7 1.5C13.6 4.2 12.8 4 12 4s-1.6.2-2.3.5C9.4 3.6 8.8 3 8 3Zm1 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>',
        custom:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h9M16 7h5M3 12h3M10 12h11M3 17h6M14 17h7"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>',
        google:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 11v2.9h4.1c-.2 1.1-1.4 3.1-4.1 3.1a4.9 4.9 0 1 1 0-9.8c1.4 0 2.4.6 2.9 1.1l2-1.9C15.5 5.1 13.9 4.5 12 4.5a7.5 7.5 0 1 0 0 15c4.3 0 7.2-3 7.2-7.4 0-.5 0-.8-.1-1.1H12Z"/></svg>'
    };
    function provIcon(p){return '<span class="prov-ico">'+(PROVIDER_ICONS[p]||PROVIDER_ICONS.custom)+'</span>'}
    var selectedAddProvider='openai';
    window.openSettings=function(){loadSettings();loadAccess();document.getElementById('settingsModal').classList.add('active')};
    function loadAccess(){
        fetch('/api/access').then(function(r){return r.json()}).then(function(d){
            document.getElementById('accInstitution').value=d.institution||'';
            document.getElementById('accR4LUser').value=d.r4l_user||'';
        }).catch(function(){});
    }
    window.saveAccess=function(){
        var body={institution:document.getElementById('accInstitution').value.trim(),r4l_user:document.getElementById('accR4LUser').value.trim(),r4l_pass:document.getElementById('accR4LPass').value};
        var m=document.getElementById('accMsg');m.textContent='Saving…';m.className='set-msg';
        fetch('/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(d){if(d.error){m.textContent=d.error;m.className='set-msg err'}else{m.textContent='Saved.';m.className='set-msg ok';document.getElementById('accR4LPass').value='';setTimeout(function(){m.textContent=''},1500)}})
        .catch(function(){m.textContent='Failed.';m.className='set-msg err'});
    };
    function loadSettings(){
        fetch('/api/ai/status').then(function(r){return r.json()}).then(function(d){
            // default provider dropdown: ready + connected + catalog
            var avail={}; (d.providers||[]).forEach(function(p){avail[p.provider]=p.model});
            (d.connected||[]).forEach(function(c){avail[c.provider]=c.model||avail[c.provider]});
            var sel=document.getElementById('setProvider');
            var opts='<option value="">Auto (best available)</option>';
            (d.catalog||[]).forEach(function(p){
                var ready=avail.hasOwnProperty(p)?' (ready)':'';
                opts+='<option value="'+p+'">'+(PROVIDER_LABELS[p]||p)+ready+'</option>';
            });
            sel.innerHTML=opts;
            sel.value=(d.settings&&d.settings.default_provider)||'';
            document.getElementById('setModel').value=(d.settings&&d.settings.default_model)||'';
            // add-provider icon tiles
            renderAddTiles(d.catalog||[]);
            // connected list (with icons)
            var c=document.getElementById('setConnected');
            var list=(d.connected||[]);
            if(!list.length){c.innerHTML='<div class="set-empty">No providers connected. Ollama and any env keys work automatically.</div>'}
            else{c.innerHTML=list.map(function(x){
                return '<div class="set-conn"><span class="set-conn-id">'+provIcon(x.provider)+'<b>'+(PROVIDER_LABELS[x.provider]||x.provider)+'</b> <span class="set-hint">'+esc(x.model||'')+' · key '+esc(x.key_hint)+'</span></span><button class="drive-btn ghost" data-p="'+esc(x.provider)+'">Disconnect</button></div>';
            }).join('');
            Array.prototype.forEach.call(c.querySelectorAll('button[data-p]'),function(b){b.onclick=function(){disconnectProvider(b.getAttribute('data-p'))}});}
        }).catch(function(){});
    }
    function renderAddTiles(catalog){
        var keyed=catalog.filter(function(p){return p!=='ollama'});  // ollama needs no key
        var g=document.getElementById('addProviderTiles');
        g.innerHTML=keyed.map(function(p){
            return '<button class="prov-tile'+(p===selectedAddProvider?' on':'')+'" data-p="'+p+'">'+provIcon(p)+'<span>'+(PROVIDER_LABELS[p]||p)+'</span></button>';
        }).join('');
        Array.prototype.forEach.call(g.querySelectorAll('.prov-tile'),function(b){b.onclick=function(){selectedAddProvider=b.getAttribute('data-p');renderAddTiles(catalog);window.onAddProvider()}});
    }
    window.onAddProvider=function(){document.getElementById('addBase').style.display=selectedAddProvider==='custom'?'block':'none'};
    window.saveSettings=function(){
        fetch('/api/ai/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_provider:document.getElementById('setProvider').value,default_model:document.getElementById('setModel').value.trim()})})
        .then(function(r){return r.json()}).then(function(){var m=document.getElementById('addMsg');m.textContent='Saved.';m.className='set-msg ok';setTimeout(function(){m.textContent=''},1500)});
    };
    window.connectProvider=function(){
        var body={provider:selectedAddProvider,key:document.getElementById('addKey').value.trim(),model:document.getElementById('addModel').value.trim(),base_url:document.getElementById('addBase').value.trim()};
        var m=document.getElementById('addMsg');m.textContent='Connecting…';m.className='set-msg';
        fetch('/api/ai/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(d){
            if(d.error){m.textContent=d.error;m.className='set-msg err';return}
            m.textContent='Connected.';m.className='set-msg ok';
            document.getElementById('addKey').value='';document.getElementById('addModel').value='';document.getElementById('addBase').value='';
            loadSettings();
        }).catch(function(){m.textContent='Failed.';m.className='set-msg err'});
    };
    function disconnectProvider(p){
        fetch('/api/ai/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:p})})
        .then(function(){loadSettings()});
    }

    // ── Systematic review: search-strategy builder ───────────────────
    var SR_LABELS=['Population / Phenomenon','Realm / Domain','Intervention / Input','Standard / Comparator','Measure / Outcome','Time / Temporal','Geography / Setting','Design / Methodology'];
    var lastStrategy=null, lastResults=[];
    // ── Pill / tag input ─────────────────────────────────────────────
    function createTag(container,text){
        text=String(text).trim(); if(!text)return;
        var input=container.querySelector('.sr-tag-input');
        var tag=document.createElement('span'); tag.className='sr-tag'; tag.setAttribute('data-term',text);
        tag.appendChild(document.createTextNode(text));
        var x=document.createElement('button'); x.className='sr-tag-x'; x.type='button'; x.textContent='×';
        x.onclick=function(){tag.remove()};
        tag.appendChild(x); container.insertBefore(tag,input);
    }
    function readTags(container){
        var terms=Array.prototype.map.call(container.querySelectorAll('.sr-tag'),function(t){return t.getAttribute('data-term')}).filter(Boolean);
        var pend=container.querySelector('.sr-tag-input').value.trim(); if(pend)terms.push(pend);
        return terms;
    }
    function wireTags(container){
        var input=container.querySelector('.sr-tag-input');
        container.addEventListener('mousedown',function(e){if(e.target===container)input.focus()});
        input.addEventListener('keydown',function(e){
            if(e.key==='Enter'||e.key===','){e.preventDefault();createTag(container,input.value);input.value=''}
            else if(e.key==='Backspace'&&!input.value){var t=container.querySelectorAll('.sr-tag');if(t.length)t[t.length-1].remove()}
        });
        input.addEventListener('blur',function(){if(input.value.trim()){createTag(container,input.value);input.value=''}});
        input.addEventListener('paste',function(){setTimeout(function(){if(input.value.indexOf(',')>-1){input.value.split(',').forEach(function(t){createTag(container,t)});input.value=''}},0)});
    }
    function tagsContainer(initial,placeholder){
        var c=document.createElement('div'); c.className='sr-tags';
        var inp=document.createElement('input'); inp.className='sr-tag-input'; inp.placeholder=placeholder||'type a term, press Enter';
        c.appendChild(inp); wireTags(c);
        (Array.isArray(initial)?initial:(initial?String(initial).split(','):[])).forEach(function(t){createTag(c,t)});
        return c;
    }

    window.addConcept=function(label,terms){
        var wrap=document.getElementById('srConcepts');
        var row=document.createElement('div');row.className='sr-concept';
        var sel=document.createElement('select');sel.className='sr-label';
        sel.innerHTML=SR_LABELS.map(function(l){return '<option'+(l===label?' selected':'')+'>'+l+'</option>'}).join('');
        var rm=document.createElement('button');rm.className='sr-rm';rm.type='button';rm.title='Remove';rm.textContent='×';
        rm.onclick=function(){row.remove()};
        row.appendChild(sel);
        row.appendChild(tagsContainer(terms,'exposures, locations… type each, press Enter'));
        row.appendChild(rm);
        wrap.appendChild(row);
    };
    function collectConcepts(){
        var out=[];
        Array.prototype.forEach.call(document.querySelectorAll('#srConcepts .sr-concept'),function(r){
            var terms=readTags(r.querySelector('.sr-tags'));
            if(terms.length)out.push({label:r.querySelector('.sr-label').value,terms:terms});
        });
        return out;
    }
    function srMsg(t,cls){var m=document.getElementById('srMsg');m.textContent=t;m.className='sr-msg '+(cls||'')}
    function postStrategy(body,btn){
        if(btn){btn.disabled=true;btn.dataset.t=btn.textContent;btn.textContent='Building…'}
        srMsg('Resolving MeSH + building…');
        document.getElementById('srOutput').innerHTML='';
        fetch('/api/search/strategy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()})
        .then(function(d){if(btn){btn.disabled=false;btn.textContent=btn.dataset.t}
            if(d.error){srMsg(d.error,'err');return}srMsg('');renderStrategy(d)})
        .catch(function(){if(btn){btn.disabled=false;btn.textContent=btn.dataset.t}srMsg('Request failed.','err')});
    }
    function collectExclude(){var c=document.getElementById('srExclude');return c?readTags(c):[]}
    window.buildStrategy=function(){var c=collectConcepts();if(!c.length){srMsg('Add at least one facet with terms.','err');return}postStrategy({concepts:c,exclude:collectExclude()},document.getElementById('srBuildBtn'))};
    window.buildFromQuestion=function(e){var q=document.getElementById('srQuestion').value.trim();if(!q){srMsg('Type a question first.','err');return}postStrategy({question:q})};
    function renderStrategy(d){
        lastStrategy=d; lastResults=[];
        var out=document.getElementById('srOutput');
        var blocks=[['PubMed',d.pubmed],['Ovid MEDLINE / Embase',d.ovid],['Cochrane CENTRAL',d.cochrane]];
        var resolved=(d.concepts||[]).map(function(c){
            var mesh=(c.descriptors||[]).join(', ');
            return '<div class="sr-concept-tag"><b>'+esc(c.label||'')+'</b>'+(mesh?(' · MeSH: '+esc(mesh)):' · no MeSH match (free-text only)')+'</div>';
        }).join('');
        if(d.exclude&&d.exclude.length)resolved+='<div class="sr-concept-tag sr-excl-tag"><b>Excluded (NOT)</b> · '+esc(d.exclude.join(', '))+'</div>';
        out.innerHTML='<div class="sr-resolved">'+resolved+'</div>'+
            blocks.map(function(b,i){return '<div class="sr-block"><div class="sr-block-head"><span>'+esc(b[0])+'</span><button class="lib-btn sr-copy" data-i="'+i+'">Copy</button></div><pre class="sr-pre">'+esc(b[1]||'')+'</pre></div>'}).join('')+
            (d.note?('<div class="sr-note">'+esc(d.note)+'</div>'):'')+
            '<div class="sr-run">'+
              '<div class="sr-block-head" style="padding:0 0 10px"><span>Run search</span></div>'+
              '<div class="sr-run-ctl">'+
                '<select id="srSource" class="sr-label" style="width:auto"><option value="pubmed">PubMed</option><option value="europepmc">Europe PMC</option><option value="both">Both</option></select>'+
                '<input id="srMax" class="sr-terms" style="max-width:90px;flex:none" type="number" value="50" min="1" max="200" title="Max results">'+
                '<button class="drive-btn" id="srRunBtn" onclick="window.runSearch()">Run</button>'+
              '</div>'+
              '<div class="sr-results" id="srResults"></div>'+
            '</div>';
        Array.prototype.forEach.call(out.querySelectorAll('.sr-copy'),function(btn){btn.onclick=function(){
            var txt=blocks[+btn.getAttribute('data-i')][1]||'';
            if(navigator.clipboard)navigator.clipboard.writeText(txt).then(function(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy'},1200)});
        }});
    }

    window.runSearch=function(){
        if(!lastStrategy){srMsg('Build a strategy first.','err');return}
        var src=document.getElementById('srSource').value;
        var retmax=Math.max(1,Math.min(parseInt(document.getElementById('srMax').value)||50,200));
        var btn=document.getElementById('srRunBtn');btn.disabled=true;btn.textContent='Running…';
        var res=document.getElementById('srResults');res.innerHTML='<div class="sr-concept-tag">Searching '+esc(src)+'…</div>';
        fetch('/api/search/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:lastStrategy.pubmed,source:src,retmax:retmax})})
        .then(function(r){return r.json()}).then(function(d){
            btn.disabled=false;btn.textContent='Run';
            if(d.error){res.innerHTML='<div class="sr-msg err">'+esc(d.error)+'</div>';return}
            lastResults=d.records||[];renderResults(d);
        }).catch(function(){btn.disabled=false;btn.textContent='Run';res.innerHTML='<div class="sr-msg err">Search failed.</div>'});
    };
    function renderResults(d){
        var res=document.getElementById('srResults');
        var totals=Object.keys(d.totals||{}).map(function(k){return k+': '+d.totals[k]}).join(' · ');
        var head='<div class="sr-res-head"><span><b>'+(d.count||0)+'</b> unique results'+(totals?(' ('+esc(totals)+' total)'):'')+'</span>'+
            '<span class="sr-res-actions">'+
              '<button class="lib-btn" onclick="window.exportResults(\'ris\')">RIS</button>'+
              '<button class="lib-btn" onclick="window.exportResults(\'csv\')">CSV</button>'+
              '<input id="srProjName" class="sr-terms" style="max-width:150px;flex:none;padding:7px 10px" placeholder="Project name">'+
              '<button class="lib-btn" onclick="window.importResults()">Send to sandbox</button>'+
            '</span></div>';
        var rows=(d.records||[]).map(function(r){
            var meta=[r.year,r.journal,r.source].filter(Boolean).join(' · ');
            return '<div class="sr-res-item"><div class="sr-res-title">'+esc(r.title||'(untitled)')+(r.is_oa?' <span class="oa-badge">OA</span>':'')+'</div>'+
                '<div class="sr-res-meta">'+esc(meta)+(r.doi?(' · '+esc(r.doi)):'')+'</div></div>';
        }).join('');
        res.innerHTML=head+'<div class="sr-res-list">'+(rows||'<div class="sr-concept-tag">No results — adjust the strategy.</div>')+'</div>';
    }
    window.exportResults=function(fmt){
        if(!lastResults.length){srMsg('Run a search first.','err');return}
        fetch('/api/search/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:lastResults,format:fmt})})
        .then(function(r){return r.blob()}).then(function(b){
            var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='search-results.'+fmt;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();URL.revokeObjectURL(a.href)},1000);
        }).catch(function(){});
    };
    window.importResults=function(){
        if(!lastResults.length){srMsg('Run a search first.','err');return}
        var name=(document.getElementById('srProjName').value||'').trim();
        fetch('/api/search/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:lastResults,project_name:name})})
        .then(function(r){return r.json()}).then(function(d){
            if(d.error){srMsg(d.error,'err');return}
            srMsg(d.imported+' references sent to your sandbox'+(name?(' (project: '+name+')'):'')+'.','ok');
        }).catch(function(){srMsg('Import failed.','err')});
    };

    // React to the OAuth redirect landing back on the page
    (function(){
        var p=new URLSearchParams(window.location.search);
        if(p.get('drive')){history.replaceState({},'',window.location.pathname);window.showLibrary()}
    })();
})();
