(function() {
    'use strict';
    // API_BASE: '' when served by the Python backend (same origin),
    // set to the Render URL when running from GitHub Pages.
    var API_BASE=window.API_BASE||'';
    var type='video', quality='1080p', audioFmt=null, audioMode='video', subs=false, artFmt='pdf', poll=null;
    var projects=[], activeProject='all';
    var input=document.getElementById('urlInput');
    var debounce;

    var UI_ICONS={
        video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2 15 12l-5 2.8V9.2Z" fill="currentColor" stroke="none"/></svg>',
        audio:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17V5l10-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="16" cy="15" r="3"/></svg>',
        doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
        file:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>',
        chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };

    input.addEventListener('input', function(){
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        clearTimeout(debounce);
        var u=input.value.trim();
        u.length>8?debounce=setTimeout(function(){det(u)},300):hideType()
    });
    input.addEventListener('keydown', function(e){
        if(e.key==='Enter' && !e.shiftKey){
            e.preventDefault();
            startDownload();
        }
    });

    function isRawConversation(u) {
        var clean = u.trim();
        if (clean.startsWith('{') || clean.startsWith('[')) {
            try {
                var parsed = JSON.parse(clean);
                if (Array.isArray(parsed)) return true;
                if (parsed.messages || parsed.conversation || parsed.turns || parsed.mapping) return true;
            } catch(e) {}
        }
        var lines = clean.split('\n');
        if (lines.length >= 2) {
            var turnPattern = /^(user|assistant|human|ai|system|me|bot|speaker\s*\d+)\s*:/i;
            var matchCount = 0;
            for (var i = 0; i < Math.min(lines.length, 10); i++) {
                if (turnPattern.test(lines[i].trim())) {
                    matchCount++;
                }
            }
            if (matchCount >= 2) {
                return true;
            }
        }
        return false;
    }

    function det(u){
        var low = u.toLowerCase().trim();
        if(/^10\.\d{4,}/.test(low)||/doi\.org\/10\./.test(low)||/\/10\.\d{4,}\//.test(low))return showT('doi','doc','Academic Paper','DOI → open-access PDF');
        if(low.includes('arxiv.org'))return showT('arxiv','doc','arXiv Paper','Preprint');
        if(low.includes('pubmed')||low.includes('ncbi.nlm.nih.gov'))return showT('pubmed','doc','PubMed','Medical literature');
        if(/springer|wiley|sciencedirect|nature\.com|science\.org|ieee|acm/.test(low))return showT('academic','doc','Academic Article','Journal article');
        var isUrl = low.startsWith('http://') || low.startsWith('https://');
        if(low.includes('chatgpt.com/share')||low.includes('chat.openai.com/share')||low.includes('claude.ai/share')||low.includes('claude.com/share')||isRawConversation(u)||!isUrl) {
            return showT('conversation','chat','Conversation','Chat share link or transcript');
        }
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

    // ── Account menu (OCS-style TopBar: settings + logout live here) ──
    window.toggleAccount=function(e){if(e)e.stopPropagation();var m=document.getElementById('accountMenu');if(m)m.classList.toggle('open')};
    document.addEventListener('click',function(e){
        var m=document.getElementById('accountMenu'),b=document.getElementById('accountBtn');
        if(m&&m.classList.contains('open')&&!m.contains(e.target)&&b&&!b.contains(e.target))m.classList.remove('open');
    });
    (function(){
        try{
            var u=JSON.parse(localStorage.getItem('reyanda_user')||'null');
            if(u){var n=document.getElementById('accountName'),em=document.getElementById('accountEmail');
                if(n)n.textContent=u.name||(u.email||'').split('@')[0]||'Account';
                if(em)em.textContent=u.email||'';}
        }catch(_){}
    })();

    window.pickQ=function(el){document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');quality=el.dataset.q};
    window.setMode=function(m){audioMode=m;document.querySelectorAll('.audio-toggle-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===m)});document.getElementById('audioFormats').classList.toggle('active',m==='audio');document.querySelectorAll('.quality-card').forEach(function(c){c.style.opacity=m==='audio'?'0.4':'1'});if(m==='audio'){quality='audio';document.querySelectorAll('.quality-card').forEach(function(c){c.classList.remove('selected')})}else{var d=document.querySelector('.quality-card[data-q="1080p"]');if(d){d.classList.add('selected');quality='1080p'}}};
    window.pickA=function(el){document.querySelectorAll('.audio-chip[data-fmt]').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');audioFmt=el.dataset.fmt};
    window.pickArt=function(el){document.querySelectorAll('#articleOptions .audio-chip').forEach(function(c){c.classList.remove('selected')});el.classList.add('selected');artFmt=el.dataset.fmt};
    window.togSub=function(){subs=!subs;document.getElementById('subToggle').classList.toggle('active',subs)};

    window.startDownload=function(){
        var url=input.value.trim();if(!url)return;
        clearTimeout(debounce);
        det(url);
        var btn=document.getElementById('downloadBtn');
        btn.classList.add('loading');btn.disabled=true;

        if(type==='conversation'){
            fetch(API_BASE+'/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,type:'conversation'})})
            .then(function(r){return r.json()}).then(function(d){
                if(d.error){alert(d.error);return}
                pollConv(d.download_id);
            }).catch(function(e){alert(e.message||'Failed')})
            .finally(function(){btn.classList.remove('loading');btn.disabled=false});
            return;
        }

        document.getElementById('progressSection').classList.add('active');
        resetProg();showSt('loading','Resolving...');

        fetch(API_BASE+'/api/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,type:type==='video'?'auto':type,quality:quality,format:audioMode==='audio'?(audioFmt||'mp3'):'mp4',subtitles:subs})})
        .then(function(res){return res.json()})
        .then(function(d){if(d.error)throw new Error(d.error);pollSt(d.download_id,d.type)})
        .catch(function(e){showSt('error',e.message||'Failed')})
        .finally(function(){btn.classList.remove('loading');btn.disabled=false});
    };

    function pollConv(id){
        var tries=0;
        var iv=setInterval(function(){
            tries++;
            fetch(API_BASE+'/api/status/'+encodeURIComponent(id))
            .then(function(r){return r.json()})
            .then(function(d){
                if(d.status==='done'||d.status==='ready'){
                    clearInterval(iv);
                    input.value='';
                    hideType();
                    showMain();
                    loadProjects().then(function(){loadLibrary('')});
                    window.showLibrary();
                }else if(d.status==='error'||tries>60){
                    clearInterval(iv);
                    alert(d.message||d.error||'Conversation save failed');
                }
            }).catch(function(){});
        },1000);
    }

    function pollSt(id,dlType){
        var misses=0;
        poll=setInterval(function(){
            fetch(API_BASE+'/api/status/'+encodeURIComponent(id))
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

    function triggerDl(id){var a=document.createElement('a');a.href=API_BASE+'/api/stream/'+encodeURIComponent(id);a.style.display='none';document.body.appendChild(a);a.click();setTimeout(function(){a.remove()},1000)}

    // ── Library ──────────────────────────────────────────────────────
    var TYPE_ICON={video:UI_ICONS.video,article:UI_ICONS.doc,conversation:UI_ICONS.chat};
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
        fetch(API_BASE+'/api/library'+(params.length?('?'+params.join('&')):''))
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
                (it.filename?('<a class="lib-btn" href="'+API_BASE+'/api/stream/'+encodeURIComponent(it.id)+'">Download</a>'):'')+
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
        fetch(API_BASE+'/api/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
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
        fetch(API_BASE+'/api/resource/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,project:pid})})
        .then(function(r){return r.json()}).then(function(){loadProjects();refreshLibIfOpen()}).catch(function(){});
    }

    function delRes(id){
        fetch(API_BASE+'/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
        .then(function(r){return r.json()})
        .then(function(){refreshLibIfOpen()})
        .catch(function(){});
    }

    // ── Google Drive ─────────────────────────────────────────────────
    var drive={configured:false,connected:false,email:null};
    function loadDrive(){
        return fetch(API_BASE+'/api/auth/status').then(function(r){return r.json()})
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
                fetch(API_BASE+'/api/auth/logout',{method:'POST'}).then(function(){loadDrive().then(refreshLibIfOpen)})};
        }else{
            bar.innerHTML='<span class="drive-status"><span class="drive-dot"></span>Save your library to Google Drive</span>'+
                '<button class="drive-btn" onclick="window.connectDrive()">Connect Drive</button>';
        }
    }
    window.connectDrive=function(){window.location.href='/api/auth/google/start'};
    function syncDrive(id,btn){
        if(btn){btn.disabled=true;btn.textContent='…'}
        fetch(API_BASE+'/api/drive/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
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
        fetch(API_BASE+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
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
        return fetch(API_BASE+'/api/projects').then(function(r){return r.json()})
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
        fetch(API_BASE+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})})
        .then(function(r){return r.json()}).then(function(d){if(d.project){activeProject=d.project.id}loadProjects().then(function(){renderProjBar();loadLibrary('')})}).catch(function(){});
    }
    function projectMenu(id){
        var p=projects.filter(function(x){return x.id===id})[0]; if(!p)return;
        var act=prompt('Type "rename" or "delete" for project "'+p.name+'":'); if(!act)return;
        act=act.trim().toLowerCase();
        if(act==='delete'){
            fetch(API_BASE+'/api/projects/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
            .then(function(){if(activeProject===id)activeProject='all';loadProjects().then(function(){loadLibrary('')})});
        }else if(act==='rename'){
            var nn=prompt('New name:',p.name); if(!nn)return;
            fetch(API_BASE+'/api/projects/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,name:nn.trim()})})
            .then(function(){loadProjects()});
        }
    }

    // ── Settings (AI providers) ──────────────────────────────────────
    var PROVIDER_LABELS={openai:'OpenAI',anthropic:'Anthropic',groq:'Groq',openrouter:'OpenRouter',deepseek:'DeepSeek',glm:'GLM (Z.ai)',kimi:'Kimi',ollama:'Ollama',opencode:'OpenCode',custom:'Custom'};
    var PROVIDER_ICONS={
        openai:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
        anthropic:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
        groq:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a7 7 0 1 0 2 13.7V14.5A4.8 4.8 0 1 1 16.8 12H19A7 7 0 0 0 12 3Zm0 4.2a4.8 4.8 0 0 0-.1 9.6V14.5a2.6 2.6 0 1 1 .1-5.1V7.2Z"/></svg>',
        openrouter:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/></svg>',
        deepseek:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/></svg>',
        glm:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M12 7.5 16 10v4l-4 2.5L8 14v-4z"/></svg>',
        kimi:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866"/></svg>',
        ollama:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z"/></svg>',
        opencode:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="2 3"/></svg>',
        custom:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h9M16 7h5M3 12h3M10 12h11M3 17h6M14 17h7"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>',
        google:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
    };
    function provIcon(p){return '<span class="prov-ico">'+(PROVIDER_ICONS[p]||PROVIDER_ICONS.custom)+'</span>'}
    var selectedAddProvider='openai';
    window.openSettings=function(){loadSettings();loadAccess();document.getElementById('settingsModal').classList.add('active')};
    function loadAccess(){
        fetch(API_BASE+'/api/access').then(function(r){return r.json()}).then(function(d){
            document.getElementById('accInstitution').value=d.institution||'';
            document.getElementById('accR4LUser').value=d.r4l_user||'';
        }).catch(function(){});
    }
    window.saveAccess=function(){
        var body={institution:document.getElementById('accInstitution').value.trim(),r4l_user:document.getElementById('accR4LUser').value.trim(),r4l_pass:document.getElementById('accR4LPass').value};
        var m=document.getElementById('accMsg');m.textContent='Saving…';m.className='set-msg';
        fetch(API_BASE+'/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(d){if(d.error){m.textContent=d.error;m.className='set-msg err'}else{m.textContent='Saved.';m.className='set-msg ok';document.getElementById('accR4LPass').value='';setTimeout(function(){m.textContent=''},1500)}})
        .catch(function(){m.textContent='Failed.';m.className='set-msg err'});
    };
    function loadSettings(){
        fetch(API_BASE+'/api/ai/status').then(function(r){return r.json()}).then(function(d){
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
            // populate model dropdown for the current default provider
            var modelSel=document.getElementById('setModel');
            var savedModel=(d.settings&&d.settings.default_model)||'';
            var curProv=(d.settings&&d.settings.default_provider)||'';
            if(curProv){
                modelSel.innerHTML='<option value="">Loading…</option>';
                fetchModelsForProvider(curProv, null, null, function(models){
                    populateModelSelect(modelSel, models, 'Auto (default)');
                    if(savedModel)modelSel.value=savedModel;
                });
            } else {
                modelSel.innerHTML='<option value="">Auto (default)</option>';
            }
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
        fetch(API_BASE+'/api/ai/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_provider:document.getElementById('setProvider').value,default_model:document.getElementById('setModel').value.trim()})})
        .then(function(r){return r.json()}).then(function(){var m=document.getElementById('addMsg');m.textContent='Saved.';m.className='set-msg ok';setTimeout(function(){m.textContent=''},1500)});
    };
    window.connectProvider=function(){
        var body={provider:selectedAddProvider,key:document.getElementById('addKey').value.trim(),model:document.getElementById('addModel').value,base_url:document.getElementById('addBase').value.trim()};
        var m=document.getElementById('addMsg');m.textContent='Connecting…';m.className='set-msg';
        fetch(API_BASE+'/api/ai/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(d){
            if(d.error){m.textContent=d.error;m.className='set-msg err';return}
            m.textContent='Connected.';m.className='set-msg ok';
            document.getElementById('addKey').value='';document.getElementById('addModel').innerHTML='<option value="">Auto-detect</option>';document.getElementById('addBase').value='';
            loadSettings();
        }).catch(function(){m.textContent='Failed.';m.className='set-msg err'});
    };
    function disconnectProvider(p){
        fetch(API_BASE+'/api/ai/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:p})})
        .then(function(){loadSettings()});
    }
    function populateModelSelect(sel, models, placeholder){
        var opts='<option value="'+(placeholder||'')+'">'+(placeholder||'Auto')+'</option>';
        (models||[]).slice(0,300).forEach(function(m){opts+='<option value="'+esc(m)+'">'+esc(m)+'</option>'});
        sel.innerHTML=opts;
    }
    function fetchModelsForProvider(provider, key, baseUrl, callback){
        var body={provider:provider};
        if(key)body.key=key;
        if(baseUrl)body.base_url=baseUrl;
        fetch(API_BASE+'/api/ai/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json()}).then(function(d){callback(d.models||[],d.error)}).catch(function(){callback([],null)});
    }
    window.onSettingsProviderChange=function(){
        var p=document.getElementById('setProvider').value; if(!p)return;
        var sel=document.getElementById('setModel');
        sel.innerHTML='<option value="">Loading…</option>';
        fetchModelsForProvider(p, null, null, function(models,err){
            if(err||!models.length){sel.innerHTML='<option value="">Auto (default)</option>';return}
            populateModelSelect(sel, models, 'Auto (default)');
        });
    };
    window.detectModels=function(){
        var m=document.getElementById('addMsg');m.textContent='Detecting models…';m.className='set-msg';
        fetchModelsForProvider(selectedAddProvider, document.getElementById('addKey').value.trim(), document.getElementById('addBase').value.trim(), function(models,err){
            if(err){m.textContent=err;m.className='set-msg err';return}
            var sel=document.getElementById('addModel');
            populateModelSelect(sel, models, 'Auto-detect');
            var n=models.length; m.textContent=n+' models found.';m.className='set-msg ok';
            if(n)sel.value=models[0];
        });
    };
    window.onAddProvider=function(){
        document.getElementById('addBase').style.display=selectedAddProvider==='custom'?'block':'none';
        var sel=document.getElementById('addModel');
        sel.innerHTML='<option value="">Auto-detect</option>';
        if(selectedAddProvider==='custom')return;
        fetchModelsForProvider(selectedAddProvider, null, null, function(models){
            if(models.length)populateModelSelect(sel, models, 'Auto-detect');
        });
    };

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

    function refreshOps(){
        Array.prototype.forEach.call(document.querySelectorAll('#srConcepts .sr-concept'),function(r,i){
            var op=r.querySelector('.sr-op'); if(op)op.style.visibility=(i===0?'hidden':'visible');
        });
    }
    window.addConcept=function(label,terms,op){
        var wrap=document.getElementById('srConcepts');
        var row=document.createElement('div');row.className='sr-concept';
        var opb=document.createElement('button');opb.className='sr-op';opb.type='button';
        opb.setAttribute('data-op',op==='OR'?'OR':'AND');opb.textContent=opb.getAttribute('data-op');
        opb.title='How this facet joins the one above (click to toggle AND / OR)';
        opb.onclick=function(){var v=opb.getAttribute('data-op')==='AND'?'OR':'AND';opb.setAttribute('data-op',v);opb.textContent=v};
        var sel=document.createElement('select');sel.className='sr-label';
        sel.innerHTML=SR_LABELS.map(function(l){return '<option'+(l===label?' selected':'')+'>'+l+'</option>'}).join('');
        var rm=document.createElement('button');rm.className='sr-rm';rm.type='button';rm.title='Remove';rm.textContent='×';
        rm.onclick=function(){row.remove();refreshOps()};
        row.appendChild(opb);
        row.appendChild(sel);
        row.appendChild(tagsContainer(terms,'exposures, locations… type each, press Enter'));
        row.appendChild(rm);
        wrap.appendChild(row);
        refreshOps();
    };
    function collectConcepts(){
        var out=[];
        Array.prototype.forEach.call(document.querySelectorAll('#srConcepts .sr-concept'),function(r,i){
            var terms=readTags(r.querySelector('.sr-tags'));
            if(terms.length){var ob=r.querySelector('.sr-op');out.push({label:r.querySelector('.sr-label').value,terms:terms,op:(i===0?'AND':(ob?ob.getAttribute('data-op'):'AND'))})}
        });
        return out;
    }
    function srMsg(t,cls){var m=document.getElementById('srMsg');m.textContent=t;m.className='sr-msg '+(cls||'')}
    function postStrategy(body,btn){
        if(btn){btn.disabled=true;btn.dataset.t=btn.textContent;btn.textContent='Building…'}
        srMsg('Resolving MeSH + building…');
        document.getElementById('srOutput').innerHTML='';
        fetch(API_BASE+'/api/search/strategy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
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
        fetch(API_BASE+'/api/search/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:lastStrategy.pubmed,source:src,retmax:retmax})})
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
        fetch(API_BASE+'/api/search/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:lastResults,format:fmt})})
        .then(function(r){return r.blob()}).then(function(b){
            var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='search-results.'+fmt;document.body.appendChild(a);a.click();setTimeout(function(){a.remove();URL.revokeObjectURL(a.href)},1000);
        }).catch(function(){});
    };
    window.importResults=function(){
        if(!lastResults.length){srMsg('Run a search first.','err');return}
        var name=(document.getElementById('srProjName').value||'').trim();
        fetch(API_BASE+'/api/search/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:lastResults,project_name:name})})
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

    // Deep-link: the Systematic Review product opens its workspace directly
    // via #review (launcher tile, shared until it lives in its own repo).
    (function(){
        function openFromHash(){ if(location.hash==='#review'&&window.showReview){window.showReview();} }
        window.addEventListener('hashchange',openFromHash);
        openFromHash();
    })();

    // Unified sign-out — every product clears the shared session and returns
    // to the landing page, which is the single sign-in point for all rooms.
    window.signOut=function(){
        try{localStorage.removeItem('reyanda_user');}catch(e){}
        location.href='/';
    };
})();
