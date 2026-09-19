'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const MAX_BYTES = 3 * 1024 * 1024;
// 3 MB limitga bir martada sig‘ish uchun xavfsiz zaxira qoldiramiz.
const TARGET_BYTES = Math.floor(2.68 * 1024 * 1024);

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
  const [focus,setFocus] = useState('center');
  const [audio,setAudio] = useState('keep');
  const [volume,setVolume] = useState(100);
  const [watermark,setWatermark] = useState('');
  const [wmPos,setWmPos] = useState('br');
  const [opacity,setOpacity] = useState(70);
  const [progress,setProgress] = useState(0);
  const [status,setStatus] = useState('idle');
  const [message,setMessage] = useState('');
  const [outUrl,setOutUrl] = useState('');
  const [outSize,setOutSize] = useState(0);
  const ffmpegRef = useRef(null);
  const enginePromiseRef = useRef(null);
  const engineModeRef = useRef('single');

  const clipDuration = useMemo(()=>Math.max(0.1,end-start),[start,end]);

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
    setStatus('idle');
    setMessage('Tezkor dvigatel tayyorlanmoqda...');
    setProgress(0);
    // Foydalanuvchi sozlamalarni tanlayotgan paytda FFmpeg oldindan yuklanadi.
    setTimeout(() => {
      loadEngine(true)
        .then(() => setMessage('Tezkor rejim tayyor.'))
        .catch(() => setMessage('Dvigatel eksport vaqtida yuklanadi.'));
    }, 50);
  }

  async function loadEngine(silent=false){
    if(ffmpegRef.current) return ffmpegRef.current;
    if(enginePromiseRef.current) return enginePromiseRef.current;
    if(!silent) setMessage('Video dvigateli yuklanmoqda...');

    enginePromiseRef.current=(async()=>{
      const makeFFmpeg=()=>{
        const ffmpeg=new FFmpeg();
        ffmpeg.on('progress',({progress:p})=>setProgress(Math.min(99,Math.round((p||0)*100))));
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
          await ffmpeg.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm'),
            workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`,'text/javascript')
          });
          engineModeRef.current='multi';
          ffmpegRef.current=ffmpeg;
          return ffmpeg;
        }catch(err){
          console.warn('Multi-thread FFmpeg ishlamadi, single-threadga o‘tiladi',err);
        }
      }

      const ffmpeg=makeFFmpeg();
      const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm')
      });
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
    return {
      tl:'32:32', tr:'W-w-32:32', bl:'32:H-h-32',
      br:'W-w-32:H-h-32', c:'(W-w)/2:(H-h)/2'
    }[wmPos] || 'W-w-32:H-h-32';
  }

  function baseFilter(){
    if(cropMode==='fit') {
      return 'scale=1080:1440:force_original_aspect_ratio=decrease,pad=1080:1440:(ow-iw)/2:(oh-ih)/2:black';
    }
    const pos={
      center:'(iw-1080)/2:(ih-1440)/2',
      top:'(iw-1080)/2:0',
      bottom:'(iw-1080)/2:ih-1440',
      left:'0:(ih-1440)/2',
      right:'iw-1080:(ih-1440)/2'
    }[focus] || '(iw-1080)/2:(ih-1440)/2';
    return `scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440:${pos}`;
  }

  async function makeWatermark(ffmpeg){
    if(!watermark.trim()) return false;
    const c=document.createElement('canvas');
    const x=c.getContext('2d');
    const fs=48;
    x.font=`800 ${fs}px Arial`;
    c.width=Math.max(180,Math.ceil(x.measureText(watermark.trim()).width+48));
    c.height=88;
    x.font=`800 ${fs}px Arial`;
    x.textAlign='center';
    x.textBaseline='middle';
    x.globalAlpha=opacity/100;
    x.lineWidth=7;
    x.strokeStyle='rgba(0,0,0,.45)';
    x.strokeText(watermark.trim(),c.width/2,c.height/2);
    x.fillStyle='#fff';
    x.fillText(watermark.trim(),c.width/2,c.height/2);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    await ffmpeg.writeFile('wm.png',new Uint8Array(await blob.arrayBuffer()));
    return true;
  }

  async function encode(ffmpeg,inputName,videoK,attempt,hasWM){
    const out=`out-${attempt}.mp4`;
    const args=['-ss',start.toFixed(3),'-i',inputName];
    if(hasWM) args.push('-loop','1','-i','wm.png');
    args.push('-t',clipDuration.toFixed(3));

    if(hasWM){
      args.push(
        '-filter_complex',`[0:v]${baseFilter()}[base];[base][1:v]overlay=${overlayPos()}[v]`,
        '-map','[v]','-map','0:a?'
      );
    } else {
      args.push('-vf',baseFilter());
    }

    args.push(
      '-c:v','libx264','-preset','superfast','-pix_fmt','yuv420p',
      '-b:v',`${Math.max(80,Math.floor(videoK))}k`,
      '-maxrate',`${Math.max(90,Math.floor(videoK*1.06))}k`,
      '-bufsize',`${Math.max(160,Math.floor(videoK*2))}k`,
      '-movflags','+faststart'
    );

    if(audio==='mute') {
      args.push('-an');
    } else {
      const audioK=Math.max(32,Math.min(96,Math.floor(videoK*.16)));
      args.push('-c:a','aac','-b:a',`${audioK}k`);
      if(volume!==100) args.push('-af',`volume=${(volume/100).toFixed(2)}`);
    }

    args.push('-y',out);
    await ffmpeg.exec(args);
    const data=await ffmpeg.readFile(out);
    try{await ffmpeg.deleteFile(out);}catch{}
    return new Uint8Array(data);
  }

  function cropForAspect(w,h){
    const target=1080/1440;
    const current=w/h;
    let cw=w, ch=h, left=0, top=0;
    if(current>target){
      cw=h*target;
      if(focus==='left') left=0;
      else if(focus==='right') left=w-cw;
      else left=(w-cw)/2;
    } else if(current<target){
      ch=w/target;
      if(focus==='top') top=0;
      else if(focus==='bottom') top=h-ch;
      else top=(h-ch)/2;
    }
    return {left:Math.max(0,left),top:Math.max(0,top),width:Math.max(2,cw),height:Math.max(2,ch)};
  }

  async function fastExport(){
    if(typeof VideoEncoder==='undefined') throw new Error('WebCodecs unavailable');

    const {
      Input, Output, Conversion, ALL_FORMATS, BlobSource,
      Mp4OutputFormat, BufferTarget, canEncodeVideo, canEncodeAudio
    } = await import('mediabunny');

    const canAvc=await canEncodeVideo('avc',{width:1080,height:1440});
    if(!canAvc) throw new Error('H264 hardware codec unavailable');
    if(audio==='keep' && !(await canEncodeAudio('aac'))) throw new Error('AAC WebCodecs unavailable');
    if(audio==='keep' && volume!==100) throw new Error('Custom volume uses fallback');

    const input=new Input({
      source:new BlobSource(file),
      formats:ALL_FORMATS,
    });
    const target=new BufferTarget();
    const output=new Output({
      format:new Mp4OutputFormat(),
      target,
    });

    const totalBps=Math.floor((TARGET_BYTES*8)/clipDuration);
    const audioBps=audio==='mute'?0:64000;
    const videoBps=Math.max(120000,totalBps-audioBps-24000);
    let wmCanvas=null, wmCtx=null;

    const conversion=await Conversion.init({
      input,
      output,
      tracks:'primary',
      trim:{start,end},
      video: async track => {
        const w=await track.getDisplayWidth();
        const h=await track.getDisplayHeight();
        const opts={
          width:1080,
          height:1440,
          fit:cropMode==='fit'?'contain':'fill',
          codec:'avc',
          bitrate:videoBps,
          frameRate:30,
          hardwareAcceleration:'prefer-hardware',
          forceTranscode:true,
          keyFrameInterval:2,
        };
        if(cropMode==='cover') opts.crop=cropForAspect(w,h);
        if(watermark.trim()){
          opts.process=(sample)=>{
            if(!wmCanvas){
              wmCanvas=typeof OffscreenCanvas!=='undefined'
                ? new OffscreenCanvas(1080,1440)
                : Object.assign(document.createElement('canvas'),{width:1080,height:1440});
              wmCtx=wmCanvas.getContext('2d');
            }
            wmCtx.clearRect(0,0,1080,1440);
            sample.draw(wmCtx,0,0,1080,1440);
            const text=watermark.trim();
            const fs=48;
            wmCtx.font=`800 ${fs}px Arial`;
            wmCtx.textBaseline='middle';
            const tw=wmCtx.measureText(text).width;
            const pad=32;
            let x=pad+tw/2, y=pad+fs/2;
            if(wmPos==='tr'){x=1080-pad-tw/2;y=pad+fs/2;}
            if(wmPos==='bl'){x=pad+tw/2;y=1440-pad-fs/2;}
            if(wmPos==='br'){x=1080-pad-tw/2;y=1440-pad-fs/2;}
            if(wmPos==='c'){x=540;y=720;}
            wmCtx.textAlign='center';
            wmCtx.globalAlpha=opacity/100;
            wmCtx.lineWidth=7;
            wmCtx.strokeStyle='rgba(0,0,0,.45)';
            wmCtx.strokeText(text,x,y);
            wmCtx.fillStyle='#fff';
            wmCtx.fillText(text,x,y);
            wmCtx.globalAlpha=1;
            return wmCanvas;
          };
          opts.processedWidth=1080;
          opts.processedHeight=1440;
        }
        return opts;
      },
      audio: audio==='mute'
        ? {discard:true}
        : {codec:'aac',bitrate:64000,forceTranscode:true},
      tags:{},
    });

    if(!conversion.isValid) throw new Error('Fast conversion invalid');
    conversion.onProgress=p=>setProgress(Math.min(99,Math.round((p||0)*100)));
    setMessage('⚡ Hardware tezkor eksport...');
    await conversion.execute();

    const buffer=target.buffer;
    if(!buffer) throw new Error('No output buffer');
    return new Uint8Array(buffer);
  }

  async function exportVideo(){
    if(!file) return;
    setStatus('processing');
    setProgress(1);
    setMessage('Tezkor eksport tayyorlanmoqda...');
    setOutUrl('');
    setOutSize(0);

    try{
      let result;
      try{
        result=await fastExport();
        if(result.byteLength>MAX_BYTES){
          // Hardware encoderlar target bitrate’dan biroz oshishi mumkin.
          // Limit oshsa eski aniq FFmpeg yo‘li faqat shu holatda ishlaydi.
          throw new Error('Fast output exceeded 3 MB');
        }
      }catch(fastErr){
        console.warn('Fast path fallback:',fastErr);
        setMessage('Moslik rejimi: aniq 3 MB eksport...');
        const ffmpeg=await loadEngine();
        const ext=(file.name.split('.').pop()||'mp4').replace(/[^a-z0-9]/gi,'').toLowerCase();
        const inputName=`input.${ext||'mp4'}`;
        await ffmpeg.writeFile(inputName,await fetchFile(file));
        const totalK=Math.floor((TARGET_BYTES*8)/clipDuration/1000);
        const audioK=audio==='mute'?0:Math.max(32,Math.min(96,Math.floor(totalK*.16)));
        let videoK=Math.max(80,totalK-audioK-18);
        const hasWM=await makeWatermark(ffmpeg);
        result=await encode(ffmpeg,inputName,videoK,1,hasWM);
        if(result.byteLength>MAX_BYTES){
          videoK=Math.max(70,Math.floor(videoK*(TARGET_BYTES/result.byteLength)*.90));
          result=await encode(ffmpeg,inputName,videoK,2,hasWM);
        }
        try{await ffmpeg.deleteFile(inputName);}catch{}
        if(hasWM){try{await ffmpeg.deleteFile('wm.png');}catch{}}
      }

      const blob=new Blob([result],{type:'video/mp4'});
      const u=URL.createObjectURL(blob);
      setOutUrl(u);
      setOutSize(blob.size);
      setProgress(100);
      if(blob.size<=MAX_BYTES){
        setStatus('done');
        setMessage('Tayyor — video 3 MB limit ichida.');
      } else {
        setStatus('warning');
        setMessage('Video tayyor, lekin 3 MB dan biroz katta. Qisqaroq qirqib qayta urinib ko‘ring.');
      }
    }catch(e){
      console.error(e);
      setStatus('error');
      setMessage('Qayta ishlashda xato yuz berdi. Chrome/Edge brauzerida qayta urinib ko‘ring.');
    }
  }

  if(!file){
    return <main className="shell">
      <header><div className="logo">VIDEO<span>3MB</span></div><div className="chip">1080×1440 · MP4</div></header>
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

  return <main className="shell">
    <header><div className="logo">VIDEO<span>3MB</span></div><button className="linkBtn" onClick={()=>pick(null)}>Yangi video</button></header>
    <section className="work">
      <div className="preview card">
        <video src={src} controls onLoadedMetadata={e=>{const d=e.currentTarget.duration||0;setDuration(d);setStart(0);setEnd(d)}} />
        {watermark && <div className={`wm ${wmPos}`} style={{opacity:opacity/100}}>{watermark}</div>}
        <div className="meta"><span>{file.name}</span><span>{fmtSize(file.size)}</span><span>{fmtTime(duration)}</span></div>
      </div>

      <div className="controls card">
        <div className="block">
          <h3>1. Qirqish</h3>
          <label>Boshi <input type="range" min="0" max={Math.max(0,end-.1)} step=".1" value={start} onChange={e=>setStart(Math.min(+e.target.value,end-.1))}/><b>{fmtTime(start)}</b></label>
          <label>Oxiri <input type="range" min={Math.min(duration,start+.1)} max={duration} step=".1" value={end} onChange={e=>setEnd(Math.max(+e.target.value,start+.1))}/><b>{fmtTime(end)}</b></label>
        </div>

        <div className="block">
          <h3>2. 1080×1440 crop</h3>
          <div className="seg">
            <button className={cropMode==='cover'?'on':''} onClick={()=>setCropMode('cover')}>3:4 Crop</button>
            <button className={cropMode==='fit'?'on':''} onClick={()=>setCropMode('fit')}>To‘liq sig‘dirish</button>
          </div>
          {cropMode==='cover' && <select value={focus} onChange={e=>setFocus(e.target.value)}>
            <option value="center">Markaz</option><option value="top">Tepa</option><option value="bottom">Past</option><option value="left">Chap</option><option value="right">O‘ng</option>
          </select>}
        </div>

        <div className="block">
          <h3>3. Ovoz</h3>
          <div className="seg">
            <button className={audio==='keep'?'on':''} onClick={()=>setAudio('keep')}>🔊 Ovozli</button>
            <button className={audio==='mute'?'on':''} onClick={()=>setAudio('mute')}>🔇 Ovozsiz</button>
          </div>
          {audio==='keep' && <label>Ovoz <input type="range" min="0" max="150" value={volume} onChange={e=>setVolume(+e.target.value)}/><b>{volume}%</b></label>}
        </div>

        <div className="block">
          <h3>4. Suv belgisi</h3>
          <input className="text" placeholder="Masalan: Nur Baraka" value={watermark} onChange={e=>setWatermark(e.target.value)} />
          <div className="row">
            <select value={wmPos} onChange={e=>setWmPos(e.target.value)}>
              <option value="br">Past o‘ng</option><option value="bl">Past chap</option><option value="tr">Tepa o‘ng</option><option value="tl">Tepa chap</option><option value="c">Markaz</option>
            </select>
            <label className="opacity">Shaffoflik <input type="range" min="15" max="100" value={opacity} onChange={e=>setOpacity(+e.target.value)}/><b>{opacity}%</b></label>
          </div>
        </div>

        <div className="target"><div><small>FORMAT</small><b>1080×1440</b></div><div><small>MAX HAJM</small><b>3.00 MB</b></div></div>
        <button className="export" disabled={status==='processing'} onClick={exportVideo}>{status==='processing'?`TAYYORLANMOQDA ${progress}%`:'VIDEONI TAYYORLASH'}</button>
        {status==='processing' && <div className="bar"><i style={{width:`${progress}%`}}/></div>}
        {message && <div className={`msg ${status}`}>{message}</div>}
        {outUrl && <div className="result"><div><b>Video tayyor</b><span>{fmtSize(outSize)} · {audio==='mute'?'ovozsiz':'ovozli'}</span></div><a href={outUrl} download="video-1080x1440-3mb.mp4">YUKLAB OLISH</a></div>}
      </div>
    </section>
  </main>;
}