'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 3 * 1024 * 1024;
// 3 MB limitga bir martada sig‘ish uchun xavfsiz zaxira qoldiramiz.
const TARGET_BYTES = Math.floor(2.90 * 1024 * 1024);
const GOOD_VIDEO_K = 900;
const MIN_VIDEO_K = 80;
const AUDIO_K = 32;

const fmtTime = (s=0) => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};
const fmtSize = (b=0) => b < 1024*1024 ? `${Math.round(b/1024)} KB` : `${(b/1024/1024).toFixed(2)} MB`;

export default function Home() {
  const [file,setFile] = useState(null);
  const [src,setSrc] = useState('');
  const [duration,setDuration] = useState(0);
  const [start,setStart] = useState(0);
  const [end,setEnd] = useState(0);
  const [cropMode,setCropMode] = useState('cover');
  const [focusX,setFocusX] = useState(50);
  const [focusY,setFocusY] = useState(50);
  const [activeTool,setActiveTool] = useState('auto');
  const [currentTime,setCurrentTime] = useState(0);
  const [sourceW,setSourceW] = useState(0);
  const [sourceH,setSourceH] = useState(0);
  const [validation,setValidation] = useState(null);
  const [audio,setAudio] = useState('keep');
  const [volume,setVolume] = useState(100);
  const [speed,setSpeed] = useState(1);
  const [watermark,setWatermark] = useState('');
  const [wmX,setWmX] = useState(82);
  const [wmY,setWmY] = useState(88);
  const [wmSize,setWmSize] = useState(48);
  const [opacity,setOpacity] = useState(70);
  const [exportMode,setExportMode] = useState('3mb');
  const [compressionMode,setCompressionMode] = useState('quality');
  const [progress,setProgress] = useState(0);
  const [status,setStatus] = useState('idle');
  const [message,setMessage] = useState('');
  const [outUrl,setOutUrl] = useState('');
  const [outSize,setOutSize] = useState(0);
  const ffmpegRef = useRef(null);
  const enginePromiseRef = useRef(null);
  const engineModeRef = useRef('single');
  const videoRef = useRef(null);
  const dragRef = useRef(null);
  const wmDragRef = useRef(null);

  const clipDuration = useMemo(()=>Math.max(0.1,end-start),[start,end]);
  const outputDuration = useMemo(()=>Math.max(0.1,clipDuration/speed),[clipDuration,speed]);
  const maxClearSeconds = useMemo(()=>{
    const audioK=audio==='mute'?0:AUDIO_K;
    return Math.max(1,Math.floor((TARGET_BYTES*8/1000)/(GOOD_VIDEO_K+audioK+24)));
  },[audio]);
  const recommendedSpeed = useMemo(()=>{
    const choices=[1,1.25,1.5,1.75,2,2.5,3];
    const need=clipDuration/maxClearSeconds;
    return choices.find(v=>v>=need) || 3;
  },[clipDuration,maxClearSeconds]);
  const estimatedVideoK = useMemo(()=>{
    if(exportMode==='4k') return 0;
    const bytes=compressionMode==='fast'?Math.floor(2.76*1024*1024):TARGET_BYTES;
    const total=Math.floor((bytes*8)/outputDuration/1000);
    return Math.max(MIN_VIDEO_K,total-(audio==='mute'?0:AUDIO_K)-16);
  },[exportMode,compressionMode,outputDuration,audio]);
  const estimatedQuality = estimatedVideoK>=900?'A’lo':estimatedVideoK>=550?'Yaxshi':'Past';

  useEffect(()=>()=> {
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
  },[src,outUrl]);

  function pick(f){
    if(!f){
      setFile(null);
      if(src) URL.revokeObjectURL(src);
      if(outUrl) URL.revokeObjectURL(outUrl);
      setSrc('');
      setOutUrl('');
      setOutSize(0);
      setStatus('idle');
      setMessage('');
      setProgress(0);
      return;
    }
    if(!f.type.startsWith('video/')) return setMessage('Video fayl tanlang.');
    if(src) URL.revokeObjectURL(src);
    if(outUrl) URL.revokeObjectURL(outUrl);
    setFile(f);
    setSrc(URL.createObjectURL(f));
    setOutUrl('');
    setOutSize(0);
    setValidation(null);
    setCurrentTime(0);
    setFocusX(50);
    setFocusY(50);
    setWmX(82);
    setWmY(88);
    setStatus('idle');
    setMessage('Video tayyor. Dvigatel oldindan yuklanmoqda...');
    setProgress(0);
    loadEngine(true).then(()=>{
      setMessage(m=>m==='Video tayyor. Dvigatel oldindan yuklanmoqda...'?'Video tayyor. Eksportga tayyor.':m);
    }).catch(()=>{
      setMessage('Video tayyor. Dvigatel eksport bosilganda qayta yuklanadi.');
    });
  }

  function withTimeout(promise,ms,label){
    let timer;
    return Promise.race([
      promise.finally(()=>clearTimeout(timer)),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(label+' timeout')),ms);
      })
    ]);
  }

  async function loadEngine(silent=false){
    if(ffmpegRef.current) return ffmpegRef.current;
    if(enginePromiseRef.current) return enginePromiseRef.current;
    if(!silent) setMessage('Video dvigateli yuklanmoqda...');

    enginePromiseRef.current=(async()=>{
      const makeFFmpeg=()=>{
        const ffmpeg=new FFmpeg();
        ffmpeg.on('progress',({progress:p})=>{
          const pct=Math.max(1,Math.round((p||0)*100));
          if(pct>=98){
            setProgress(98);
            setMessage('MP4 fayl yakunlanmoqda...');
          }else{
            setProgress(Math.min(97,pct));
          }
        });
        return ffmpeg;
      };

      const canMulti = typeof crossOriginIsolated !== 'undefined'
        && crossOriginIsolated
        && typeof navigator !== 'undefined'
        && (navigator.hardwareConcurrency || 1) >= 4;

      if(canMulti){
        try{
          const ffmpeg=makeFFmpeg();
          const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/umd';
          await withTimeout(ffmpeg.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm'),
            workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`,'text/javascript')
          }),18000,'multi-core');
          engineModeRef.current='multi';
          ffmpegRef.current=ffmpeg;
          return ffmpeg;
        }catch(err){
          console.warn('Multi-thread FFmpeg ishlamadi, single-threadga o‘tiladi',err);
          try{ffmpegRef.current?.terminate?.()}catch{}
        }
      }

      const ffmpeg=makeFFmpeg();
      const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
      await withTimeout(ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm')
      }),30000,'single-core');
      engineModeRef.current='single';
      ffmpegRef.current=ffmpeg;
      return ffmpeg;
    })();

    try{
      return await enginePromiseRef.current;
    } finally {
      enginePromiseRef.current=null;
    }
  }

  function overlayPos(){
    const x=(clamp(wmX,0,100)/100).toFixed(4);
    const y=(clamp(wmY,0,100)/100).toFixed(4);
    return '(W-w)*'+x+':(H-h)*'+y;
  }

  function baseFilter(){
    const is4k=exportMode==='4k';
    const w=is4k?2160:1080;
    const h=is4k?2880:1440;
    const fps=is4k?30:20;
    const fast=compressionMode==='fast';
    const scaleFlags=fast?'bicubic':'lanczos';
    const sharp=fast?(is4k?',unsharp=3:3:0.16:3:3:0':',unsharp=3:3:0.20:3:3:0'):(is4k?',unsharp=5:5:0.48:3:3:0.20':',unsharp=5:5:0.32:3:3:0.12');
    const speedFilter=speed===1?'':',setpts=PTS/'+speed;

    if(cropMode==='fit'){
      return 'scale='+w+':'+h+':force_original_aspect_ratio=decrease:flags='+scaleFlags+',pad='+w+':'+h+':(ow-iw)/2:(oh-ih)/2:black'+sharp+',fps='+fps+speedFilter+',setsar=1,setdar=3/4';
    }
    const px=(Math.max(0,Math.min(100,focusX))/100).toFixed(3);
    const py=(Math.max(0,Math.min(100,focusY))/100).toFixed(3);
    const pos='(iw-'+w+')*'+px+':(ih-'+h+')*'+py;

    return 'scale='+w+':'+h+':force_original_aspect_ratio=increase:flags='+scaleFlags+',crop='+w+':'+h+':'+pos+sharp+',fps='+fps+speedFilter+',setsar=1,setdar=3/4';
  }

  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

  function setFocusPreset(x,y){
    setFocusX(x); setFocusY(y);
  }

  function applyUzumAuto(){
    setExportMode('3mb');
    setCropMode('cover');
    setCompressionMode('quality');
    setSpeed(recommendedSpeed);
    setAudio('keep');
    setActiveTool('auto');
    setValidation(null);
    setMessage('UZUM AUTO: sifat birinchi o‘rinda · 1080×1440 · 3:4 · ≤3 MB.');
  }

  function onCanvasPointerDown(e){
    const r=e.currentTarget.getBoundingClientRect();

    if(activeTool==='wm' && watermark.trim()){
      const x=clamp((e.clientX-r.left)/Math.max(1,r.width)*100,0,100);
      const y=clamp((e.clientY-r.top)/Math.max(1,r.height)*100,0,100);
      setWmX(x); setWmY(y);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      wmDragRef.current={x:e.clientX,y:e.clientY,wx:x,wy:y};
      return;
    }

    if(cropMode!=='cover') return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current={x:e.clientX,y:e.clientY,fx:focusX,fy:focusY};
  }

  function onCanvasPointerMove(e){
    const r=e.currentTarget.getBoundingClientRect();

    if(wmDragRef.current && activeTool==='wm'){
      const dx=(e.clientX-wmDragRef.current.x)/Math.max(1,r.width)*100;
      const dy=(e.clientY-wmDragRef.current.y)/Math.max(1,r.height)*100;
      setWmX(clamp(wmDragRef.current.wx+dx,0,100));
      setWmY(clamp(wmDragRef.current.wy+dy,0,100));
      return;
    }

    if(!dragRef.current || cropMode!=='cover') return;
    const dx=(e.clientX-dragRef.current.x)/Math.max(1,r.width)*100;
    const dy=(e.clientY-dragRef.current.y)/Math.max(1,r.height)*100;
    setFocusX(clamp(dragRef.current.fx-dx,0,100));
    setFocusY(clamp(dragRef.current.fy-dy,0,100));
  }

  function onCanvasPointerUp(e){
    dragRef.current=null;
    wmDragRef.current=null;
    try{e.currentTarget.releasePointerCapture?.(e.pointerId)}catch{}
  }

  function onWatermarkPointerDown(e){
    if(activeTool!=='wm') return;
    e.stopPropagation();
    const canvas=e.currentTarget.parentElement;
    const r=canvas.getBoundingClientRect();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    wmDragRef.current={x:e.clientX,y:e.clientY,wx:wmX,wy:wmY,rect:r};
  }

  function onWatermarkPointerMove(e){
    if(!wmDragRef.current || activeTool!=='wm') return;
    e.stopPropagation();
    const r=wmDragRef.current.rect;
    const dx=(e.clientX-wmDragRef.current.x)/Math.max(1,r.width)*100;
    const dy=(e.clientY-wmDragRef.current.y)/Math.max(1,r.height)*100;
    setWmX(clamp(wmDragRef.current.wx+dx,0,100));
    setWmY(clamp(wmDragRef.current.wy+dy,0,100));
  }

  function onWatermarkPointerUp(e){
    e.stopPropagation();
    wmDragRef.current=null;
    try{e.currentTarget.releasePointerCapture?.(e.pointerId)}catch{}
  }

  function seekTimeline(e){
    if(!duration || !videoRef.current) return;
    const r=e.currentTarget.getBoundingClientRect();
    const t=clamp((e.clientX-r.left)/r.width,0,1)*duration;
    videoRef.current.currentTime=t;
    setCurrentTime(t);
  }

  async function validateBlob(blob){
    return new Promise((resolve)=>{
      const u=URL.createObjectURL(blob);
      const v=document.createElement('video');
      const done=(data)=>{URL.revokeObjectURL(u);resolve(data)};
      v.preload='metadata';
      v.onloadedmetadata=()=>done({
        width:v.videoWidth,
        height:v.videoHeight,
        duration:v.duration,
        size:blob.size,
        sizeOK:blob.size<=MAX_BYTES,
        dimensionsOK:v.videoWidth===1080 && v.videoHeight===1440,
        ratioOK:Math.abs((v.videoWidth/v.videoHeight)-0.75)<0.001,
        formatOK:true,
        codecOK:true
      });
      v.onerror=()=>done({width:0,height:0,duration:0,size:blob.size,sizeOK:blob.size<=MAX_BYTES,dimensionsOK:false,ratioOK:false,formatOK:true,codecOK:true});
      v.src=u;
    });
  }

  async function makeWatermark(ffmpeg){
    if(!watermark.trim()) return false;
    const c=document.createElement('canvas');
    const x=c.getContext('2d');
    const fs=Math.max(20,Math.round(wmSize*(exportMode==='4k'?2:1)));
    x.font=`800 ${fs}px Arial`;
    const pad=Math.max(32,Math.round(fs));
    c.width=Math.max(fs*3,Math.ceil(x.measureText(watermark.trim()).width+pad));
    c.height=Math.max(fs*1.8,Math.round(fs+pad));
    x.font=`800 ${fs}px Arial`;
    x.textAlign='center';
    x.textBaseline='middle';
    x.globalAlpha=opacity/100;
    x.lineWidth=Math.max(3,Math.round(fs*0.14));
    x.strokeStyle='rgba(0,0,0,.45)';
    x.strokeText(watermark.trim(),c.width/2,c.height/2);
    x.fillStyle='#fff';
    x.fillText(watermark.trim(),c.width/2,c.height/2);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    await ffmpeg.writeFile('wm.png',new Uint8Array(await blob.arrayBuffer()));
    return true;
  }

  function audioTempoFilter(v){
    if(v<=2) return 'atempo='+v;
    if(v<=4) return 'atempo=2,atempo='+(v/2);
    return 'atempo=2,atempo=2,atempo='+(v/4);
  }

  async function encode(ffmpeg,inputName,videoK,attempt,hasWM,audioBitrateK=AUDIO_K){
    const out='out-'+attempt+'.mp4';
    const args=['-ss',start.toFixed(3),'-i',inputName];
    if(hasWM) args.push('-loop','1','-i','wm.png');
    args.push('-t',outputDuration.toFixed(3));

    if(hasWM){
      args.push('-filter_complex','[0:v]'+baseFilter()+'[base];[base][1:v]overlay='+overlayPos()+':shortest=1[v]','-map','[v]','-map','0:a?');
    }else{
      args.push('-vf',baseFilter());
    }

    if(exportMode==='4k'){
      args.push('-c:v','libx264','-preset',compressionMode==='fast'?'superfast':'veryfast','-profile:v','high','-level','5.1','-crf',compressionMode==='fast'?'21':'19','-threads','4','-pix_fmt','yuv420p','-movflags','+faststart');
    }else{
      const vk=Math.max(MIN_VIDEO_K,Math.floor(videoK));
      args.push('-c:v','libx264','-preset',compressionMode==='fast'?'superfast':'veryfast','-profile:v','high','-level','4.1','-threads','4','-pix_fmt','yuv420p','-b:v',vk+'k','-maxrate',Math.floor(vk*1.03)+'k','-bufsize',Math.floor(vk*1.6)+'k','-movflags','+faststart');
    }

    args.push(
      '-s:v',exportMode==='4k'?'2160x2880':'1080x1440',
      '-aspect','3:4',
      '-metadata:s:v:0','rotate=0',
      '-map_metadata','-1'
    );

    if(audio==='mute'){
      args.push('-an');
    }else{
      args.push('-c:a','aac','-b:a',(exportMode==='4k'?128:audioBitrateK)+'k');
      const af=[];
      if(speed!==1) af.push(audioTempoFilter(speed));
      if(volume!==100) af.push('volume='+(volume/100).toFixed(2));
      if(af.length) args.push('-af',af.join(','));
    }

    args.push('-y',out);
    await ffmpeg.exec(args);
    const data=await ffmpeg.readFile(out);
    try{await ffmpeg.deleteFile(out);}catch{}
    return new Uint8Array(data);
  }

  async function exportVideo(){
    if(!file) return;

    setStatus('processing');
    setProgress(2);
    setMessage('Dvigatel tekshirilmoqda...');
    setOutUrl('');
    setOutSize(0);

    try{
      const ffmpeg=await loadEngine();
      setProgress(5);
      setMessage('Video xotiraga yuklanmoqda...');
      const ext=(file.name.split('.').pop()||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase();
      const inputName='input.'+(ext||'mp4');
      await ffmpeg.writeFile(inputName,await fetchFile(file));
      setProgress(8);

      const activeTargetBytes=compressionMode==='fast'?Math.floor(2.76*1024*1024):TARGET_BYTES;
      const totalK=Math.floor((activeTargetBytes*8)/outputDuration/1000);
      let audioK=audio==='mute'?0:Math.max(24,Math.min(AUDIO_K,Math.floor(totalK*0.07)));
      let videoK=Math.max(MIN_VIDEO_K,totalK-audioK-16);
      const hasWM=await makeWatermark(ffmpeg);

      setMessage(exportMode==='4k' ? (compressionMode==='fast'?'⚡ 4K tez kodlanmoqda...':'✨ 4K maksimal sifat kodlanmoqda...') : (compressionMode==='fast'?'⚡ Tez siqish...':(engineModeRef.current==='multi'?'✨ Tiniq siqish · ko‘p yadro...':'✨ Tiniq siqish · browser FFmpeg...')));
      let result=await encode(ffmpeg,inputName,videoK,1,hasWM,audioK);

      if(exportMode==='3mb'){
        const maxAttempts=compressionMode==='fast'?2:3;
        for(let attempt=2; attempt<=maxAttempts && result.byteLength>MAX_BYTES; attempt++){
          setProgress(1);
          setMessage('3 MB ga avtomatik moslayapman — '+attempt+'/'+maxAttempts+'...');
          const ratio=activeTargetBytes/result.byteLength;
          videoK=Math.max(MIN_VIDEO_K,Math.floor(videoK*ratio*0.88));
          if(audio!=='mute') audioK=Math.max(24,Math.floor(audioK*ratio*0.94));
          result=await encode(ffmpeg,inputName,videoK,attempt,hasWM,audioK);
        }
      }

      try{await ffmpeg.deleteFile(inputName);}catch{}
      if(hasWM){try{await ffmpeg.deleteFile('wm.png');}catch{}}

      const blob=new Blob([result],{type:'video/mp4'});
      const checked=await validateBlob(blob);
      setValidation(checked);
      const u=URL.createObjectURL(blob);
      setOutUrl(u);
      setOutSize(blob.size);
      setProgress(100);

      if(exportMode==='4k'){
        setStatus('done');
        setMessage('4K MAX sifat tayyor — 2160×2880.');
      }else if(blob.size<=MAX_BYTES){
        setStatus('done');
        setMessage('UZUM tayyor — aniq 1080×1440 · 3:4 · MP4/H.264 · 3 MB ichida.');
      }else{
        setStatus('warning');
        setMessage('Video tayyor, lekin 3 MB limit juda qattiq bo‘lgani uchun hajm biroz oshdi. 3× yoki ovozsiz rejim yanada kichraytiradi.');
      }
    }catch(e){
      console.error(e);
      setStatus('error');
      setMessage(exportMode==='4k' ? '4K eksport uchun brauzer xotirasi yetmadi yoki video juda uzun.' : ((e?.message||'').includes('core')?'FFmpeg dvigateli yuklanmadi. Sahifani Ctrl+F5 qilib qayta urinib ko‘ring.':'Eksportda xato yuz berdi. Chrome yoki Edge’da qayta urinib ko‘ring.'));
    }
  }

  if(!file){
    return <main className="shell">
      <header><div className="logo">VIDEO<span>3MB</span></div><div className="chip">1080×1440 · 3 MB + 4K</div></header>
      <section className="hero">
        <div className="kicker">MARKETPLACE VIDEO TOOL</div>
        <h1>Videoni <span>3 MB</span> gacha tayyorlang</h1>
        <p>Qirqish, 3:4 crop, 1080×1440, watermark, ovozli/ovozsiz va avtomatik siqish — bitta joyda.</p>
      </section>
      <label className="drop">
        <div className="uploadIcon">↑</div>
        <h2>Video yuklang</h2>
        <p>MP4, MOV yoki WebM</p>
        <strong>VIDEO TANLASH</strong>
        <input type="file" accept="video/*" onChange={e=>pick(e.target.files?.[0])}/>
      </label>
      <p className="privacy">Video brauzeringizda qayta ishlanadi.</p>
    </main>;
  }

  return <main className="editorShell">
    <header className="editorTopbar">
      <div className="logo">VIDEO<span>3MB</span><em> V2</em></div>
      <div className="topActions">
        <button className="ghostBtn" onClick={()=>pick(null)}>＋ Yangi video</button>
        <button className="autoBtn" onClick={applyUzumAuto}>✦ UZUM AUTO</button>
      </div>
    </header>

    <section className="editorLayout">
      <aside className="toolRail">
        {[
          ['auto','✦','Auto'],
          ['crop','▣','Crop'],
          ['trim','✂','Qirqish'],
          ['speed','⚡','Tezlik'],
          ['audio','♪','Ovoz'],
          ['wm','T','Matn'],
          ['export','⇩','Export']
        ].map(([id,icon,label])=>
          <button key={id} className={activeTool===id?'active':''} onClick={()=>setActiveTool(id)}>
            <span>{icon}</span><small>{label}</small>
          </button>
        )}
      </aside>

      <section className="stageColumn">
        <div className="stageToolbar">
          <div>
            <strong>{file.name}</strong>
            <span>{sourceW||'—'}×{sourceH||'—'} · {fmtSize(file.size)} · {fmtTime(duration)}</span>
          </div>
          <div className="stageBadges">
            <b>3:4</b><b>1080×1440</b><b>≤3 MB</b>
          </div>
        </div>

        <div className="canvasWrap">
          <div
            className="videoCanvas"
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
          >
            <video
              ref={videoRef}
              src={src}
              controls
              style={{
                objectFit:cropMode==='cover'?'cover':'contain',
                objectPosition:focusX+'% '+focusY+'%'
              }}
              onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime||0)}
              onLoadedMetadata={e=>{
                const v=e.currentTarget;
                const d=v.duration||0;
                setDuration(d);setStart(0);setEnd(d);
                setSourceW(v.videoWidth||0);setSourceH(v.videoHeight||0);
              }}
            />
            {activeTool==='wm' && watermark ? <div className="dragHint">✥ Suv belgisi joyini preview ustida belgilang</div> : (cropMode==='cover' && <div className="dragHint">↔ Videoni tortib markazni tanlang</div>)}
            <div className="safeFrame"><span>UZUM 1080×1440</span></div>
            {watermark && <div
              className={'wm manual '+(activeTool==='wm'?'editing':'')}
              style={{
                opacity:opacity/100,
                left:wmX+'%',
                top:wmY+'%',
                fontSize:Math.max(12,wmSize*0.42)+'px'
              }}
              onPointerDown={onWatermarkPointerDown}
              onPointerMove={onWatermarkPointerMove}
              onPointerUp={onWatermarkPointerUp}
              onPointerCancel={onWatermarkPointerUp}
            >{watermark}</div>}
          </div>
        </div>

        <div className="timeline card">
          <div className="timelineHead">
            <strong>Timeline</strong>
            <span>{fmtTime(currentTime)} / {fmtTime(duration)}</span>
          </div>
          <div className="timelineTrack" onClick={seekTimeline}>
            <div className="trimShade left" style={{width:(duration?start/duration*100:0)+'%'}}/>
            <div className="clipRegion" style={{
              left:(duration?start/duration*100:0)+'%',
              width:(duration?(end-start)/duration*100:100)+'%'
            }}/>
            <div className="playhead" style={{left:(duration?currentTime/duration*100:0)+'%'}}/>
            {Array.from({length:12}).map((_,i)=><i key={i} style={{left:(i/11*100)+'%'}}/>)}
          </div>
          <div className="trimRow">
            <label>Boshi <input type="number" min="0" max={end-.1} step=".1" value={start.toFixed(1)} onChange={e=>setStart(clamp(+e.target.value,0,end-.1))}/><b>{fmtTime(start)}</b></label>
            <label>Oxiri <input type="number" min={start+.1} max={duration} step=".1" value={end.toFixed(1)} onChange={e=>setEnd(clamp(+e.target.value,start+.1,duration))}/><b>{fmtTime(end)}</b></label>
            <div className="durationPill">Chiqish: <b>{Math.ceil(outputDuration)} sek.</b></div>
          </div>
        </div>
      </section>

      <aside className="inspector card">
        <div className="inspectorHeader">
          <div><strong>{activeTool==='auto'?'UZUM AUTO':activeTool==='crop'?'Canvas / Crop':activeTool==='trim'?'Qirqish':activeTool==='speed'?'Tezlik':activeTool==='audio'?'Ovoz':activeTool==='wm'?'Matn / Watermark':'Export'}</strong>
          <span>Marketplace video editor</span></div>
        </div>

        {activeTool==='auto' && <div className="panel">
          <div className="autoHero">
            <span>✦</span>
            <h3>Uzum uchun 1 bosishda</h3>
            <p>1080×1440 · 3:4 · MP4/H.264 · 3 MB dan katta emas.</p>
            <button onClick={applyUzumAuto}>UZUM AUTO SOZLASH</button>
          </div>
          <div className="checkGrid">
            <div><small>Format</small><b>1080×1440</b></div>
            <div><small>Hajm</small><b>≤ 3 MB</b></div>
            <div><small>Aspect</small><b>3:4 · SAR 1:1</b></div>
            <div><small>Codec</small><b>MP4 · H.264</b></div>
          </div>
          <div className={'qualityMeter '+(estimatedQuality==='Past'?'low':'')}>
            <span>Taxminiy sifat</span><b>{estimatedQuality}</b><small>~{estimatedVideoK} kbps · sifat ustuvor</small>
          </div>
        </div>}

        {activeTool==='crop' && <div className="panel">
          <h3>Canvas</h3>
          <div className="seg">
            <button className={cropMode==='cover'?'on':''} onClick={()=>setCropMode('cover')}>Fill / Crop</button>
            <button className={cropMode==='fit'?'on':''} onClick={()=>setCropMode('fit')}>Fit</button>
          </div>
          {cropMode==='cover' && <>
            <p className="panelHint">Preview ichidagi videoni torting yoki tayyor fokusdan tanlang.</p>
            <div className="focusGrid">
              <button onClick={()=>setFocusPreset(50,0)}>↑</button>
              <button onClick={()=>setFocusPreset(50,50)}>●</button>
              <button onClick={()=>setFocusPreset(50,100)}>↓</button>
              <button onClick={()=>setFocusPreset(0,50)}>←</button>
              <button onClick={()=>setFocusPreset(100,50)}>→</button>
            </div>
            <label className="sliderLabel">Gorizontal <input type="range" min="0" max="100" value={focusX} onChange={e=>setFocusX(+e.target.value)}/><b>{focusX}%</b></label>
            <label className="sliderLabel">Vertikal <input type="range" min="0" max="100" value={focusY} onChange={e=>setFocusY(+e.target.value)}/><b>{focusY}%</b></label>
          </>}
        </div>}

        {activeTool==='trim' && <div className="panel">
          <h3>Qirqish</h3>
          <label className="sliderLabel">Boshlanish <input type="range" min="0" max={Math.max(0,end-.1)} step=".1" value={start} onChange={e=>setStart(Math.min(+e.target.value,end-.1))}/><b>{fmtTime(start)}</b></label>
          <label className="sliderLabel">Tugash <input type="range" min={Math.min(duration,start+.1)} max={duration} step=".1" value={end} onChange={e=>setEnd(Math.max(+e.target.value,start+.1))}/><b>{fmtTime(end)}</b></label>
        </div>}

        {activeTool==='speed' && <div className="panel">
          <h3>Video tezligi</h3>
          <div className="speedGrid">
            {[1,1.25,1.5,1.75,2,2.5,3].map(v=><button key={v} className={speed===v?'on':''} onClick={()=>setSpeed(v)}>{v}×</button>)}
          </div>
          <div className="recommend">Tavsiya: <b>{recommendedSpeed}×</b><span>Chiqish {Math.ceil(outputDuration)} sek.</span></div>
        </div>}

        {activeTool==='audio' && <div className="panel">
          <h3>Ovoz</h3>
          <div className="seg">
            <button className={audio==='keep'?'on':''} onClick={()=>setAudio('keep')}>🔊 Ovozli</button>
            <button className={audio==='mute'?'on':''} onClick={()=>setAudio('mute')}>🔇 Ovozsiz</button>
          </div>
          {audio==='keep' && <label className="sliderLabel">Volume <input type="range" min="0" max="150" value={volume} onChange={e=>setVolume(+e.target.value)}/><b>{volume}%</b></label>}
        </div>}

        {activeTool==='wm' && <div className="panel">
          <h3>Watermark / matn</h3>
          <input className="text" placeholder="Masalan: Nur Baraka" value={watermark} onChange={e=>setWatermark(e.target.value)}/>
          <div className="wmHelp">1. Matnni yozing. 2. Preview ustiga bosing yoki suv belgisini sudrab kerakli joyga qo‘ying.</div>
          <label className="sliderLabel">Hajmi <input type="range" min="24" max="120" value={wmSize} onChange={e=>setWmSize(+e.target.value)}/><b>{wmSize}px</b></label>
          <label className="sliderLabel">Shaffoflik <input type="range" min="15" max="100" value={opacity} onChange={e=>setOpacity(+e.target.value)}/><b>{opacity}%</b></label>
          <div className="wmCoords">
            <span>X <b>{Math.round(wmX)}%</b></span>
            <span>Y <b>{Math.round(wmY)}%</b></span>
            <button onClick={()=>{setWmX(50);setWmY(50)}}>Markazga</button>
          </div>
        </div>}

        {activeTool==='export' && <div className="panel">
          <h3>Export sozlamalari</h3>
          <div className="presetCard selected">
            <div><b>Uzum Market</b><span>1080×1440 · ≤3 MB · H.264</span></div><strong>✓</strong>
          </div>
          <div className="seg">
            <button className={compressionMode==='fast'?'on':''} onClick={()=>setCompressionMode('fast')}>⚡ Tez</button>
            <button className={compressionMode==='quality'?'on':''} onClick={()=>setCompressionMode('quality')}>✨ Tiniq</button>
          </div>
          <div className="exportFacts">
            <span>Resolution <b>1080×1440</b></span>
            <span>FPS <b>20</b></span>
            <span>Audio <b>{audio==='mute'?'Off':'32 kbps'}</b></span>
            <span>Rejim <b>Sifat ustuvor</b></span>
            <span>Taxminiy sifat <b>{estimatedQuality}</b></span>
          </div>
        </div>}

        <div className="exportDock">
          {validation && <div className={'validator '+(validation.dimensionsOK&&validation.sizeOK?'pass':'fail')}>
            <strong>{validation.dimensionsOK&&validation.sizeOK?'✓ UZUM CHECK: TAYYOR':'! UZUM CHECK: MUAMMO'}</strong>
            <span>{validation.width}×{validation.height} · {fmtSize(validation.size)}</span>
            <small>{validation.dimensionsOK?'✓ 1080×1440':'✕ O‘lcham'} · {validation.sizeOK?'✓ ≤3 MB':'✕ 3 MB dan katta'} · {validation.ratioOK?'✓ 3:4':'✕ Aspect'}</small>
          </div>}
          {message && <div className={'msg '+status}>{message}</div>}
          <button className="export primary" disabled={status==='processing'} onClick={exportVideo}>
            {status==='processing'?('TAYYORLANMOQDA '+progress+'%'):'UZUM UCHUN EXPORT'}
          </button>
          {status==='processing' && <div className="bar"><i style={{width:progress+'%'}}/></div>}
          {outUrl && <a className="downloadV2" href={outUrl} download="uzum-1080x1440-3mb.mp4">↓ YUKLAB OLISH · {fmtSize(outSize)}</a>}
        </div>
      </aside>
    </section>
  </main>;
}