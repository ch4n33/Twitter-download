import { build } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const probeOnly = process.argv.includes('--probe');
const firefox = process.env.GIF_POC_FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const temporary = await mkdtemp(path.join(tmpdir(), 'twitter-gif-verify-'));
const output = path.join(root, 'release/gif-poc');
const fixtures = [
  { name: 'motion', filter: 'testsrc2=size=320x180:rate=15:duration=2' },
  { name: 'gradient', filter: 'gradients=size=640x360:rate=24:duration=2:c0=0xff5500:c1=0x0066cc:x0=0:y0=0:x1=640:y1=360' },
];
let browser;
let server;
try {
  const resources = new Map();
  if (!probeOnly) {
    const bundle = await build({ absWorkingDir: root, entryPoints: ['src/conversion/gif-worker.ts'],
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'firefox145' });
    resources.set('/gif-worker.js', { type: 'text/javascript', body: bundle.outputFiles[0].contents });
    for (const fixture of fixtures) {
      const source = path.join(temporary, `${fixture.name}.mp4`);
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', fixture.filter,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source]);
      resources.set(`/${fixture.name}.mp4`, { type: 'video/mp4', body: await readFile(source) });
    }
    await mkdir(output, { recursive: true });
  }
  const workerCode = `
    async function convert(name) {
      const input = await (await fetch('/'+name+'.mp4')).arrayBuffer();
      const worker = new Worker('/gif-worker.js', {type:'module'});
      const started = performance.now();
      try {
        const buffer = await new Promise((resolve,reject)=>{
          worker.onmessage=event=>{
            const message=event.data;
            if(message.type==='complete') resolve(message.buffer);
            if(message.type==='error') reject(new Error(message.error));
          };
          worker.onerror=event=>reject(new Error(event.message));
          worker.postMessage({type:'convert',id:name,input},[input]);
        });
        const response=await fetch('/result?name='+name,{method:'POST',body:buffer});
        if(!response.ok) throw new Error('Result upload failed');
        return {name,milliseconds:Math.round(performance.now()-started),bytes:buffer.byteLength};
      } finally {worker.terminate();}
    }
    (async()=>{
      try {
        const result={videoDecoder:typeof VideoDecoder!=='undefined',offscreenCanvas:typeof OffscreenCanvas!=='undefined',fixtures:[]};
        if(!${probeOnly}) for(const name of ${JSON.stringify(fixtures.map(item => item.name))}) result.fixtures.push(await convert(name));
        await fetch('/report',{method:'POST',body:JSON.stringify(result)});
      } catch(error) {await fetch('/report',{method:'POST',body:JSON.stringify({error:String(error)})});}
    })();`;
  let resolveReport;
  const reportPromise = new Promise(resolve => { resolveReport = resolve; });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'POST') {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 65 * 1024 * 1024) throw new Error('Oversized fixture output');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        if (url.pathname === '/report') resolveReport(JSON.parse(body.toString()));
        else if (url.pathname === '/result') {
          const name = url.searchParams.get('name');
          if (!fixtures.some(item => item.name === name)) throw new Error('Unknown fixture');
          await writeFile(path.join(output, `${name}.gif`), body);
        } else throw new Error('Unknown route');
        response.writeHead(200).end('ok');
        return;
      }
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`<meta charset="utf-8"><script type="module">${workerCode}</script>`);
        return;
      }
      const resource = resources.get(url.pathname);
      if (!resource) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': resource.type }).end(resource.body);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  browser = spawn(firefox, ['--headless', '--no-remote', '--profile', path.join(temporary, 'profile'),
    `http://127.0.0.1:${address.port}/`], { stdio: ['ignore', 'ignore', 'ignore'] });
  const report = await Promise.race([
    reportPromise,
    new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Firefox GIF verification timed out')), 180_000); timeout.unref(); }),
    new Promise((_, reject) => browser.once('error', reject)),
  ]);
  if (report.error) throw new Error(report.error);
  for (const fixture of report.fixtures) {
    const inspect = async file => JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
      'stream=width,height,nb_read_frames,duration:format=duration', '-of', 'json', file])).stdout);
    fixture.source = await inspect(path.join(temporary, `${fixture.name}.mp4`));
    fixture.gif = await inspect(path.join(output, `${fixture.name}.gif`));
    const source = fixture.source.streams[0];
    const gif = fixture.gif.streams[0];
    if (source.width !== gif.width || source.height !== gif.height
      || source.nb_read_frames !== gif.nb_read_frames) throw new Error(`${fixture.name}: dimensions or frame count changed`);
    const durationError = Math.abs(Number(fixture.source.format.duration) - Number(fixture.gif.format.duration));
    if (durationError > 0.03) throw new Error(`${fixture.name}: duration drift ${durationError}s`);
    const bytes = await readFile(path.join(output, `${fixture.name}.gif`));
    const loopOffset = bytes.indexOf(Buffer.from('NETSCAPE2.0')) + 11;
    if (bytes.subarray(0, 6).toString() !== 'GIF89a' || bytes.at(-1) !== 0x3b
      || loopOffset < 11 || bytes[loopOffset] !== 3 || bytes[loopOffset + 1] !== 1
      || bytes.readUInt16LE(loopOffset + 2) !== 0) throw new Error(`${fixture.name}: invalid GIF or missing infinite loop`);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(output, `${fixture.name}.gif`), '-frames:v', '1',
      path.join(output, `${fixture.name}.png`)]);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(temporary, `${fixture.name}.mp4`), '-frames:v', '1',
      path.join(output, `${fixture.name}-source.png`)]);
  }
  if (!probeOnly) await writeFile(path.join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(temporary, { recursive: true, force: true });
}
