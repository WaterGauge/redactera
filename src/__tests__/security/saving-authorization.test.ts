import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCoreHandlers } from '../../main/ipcHandlers';
import { createPathValidator } from '../../main/pathValidator';

type Handler = (...args: unknown[]) => unknown;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function harness() {
  const root=fs.mkdtempSync(path.join(process.env.CR007_TEST_TMPDIR ?? os.tmpdir(), 'cr007-'));
  roots.push(root);
  const source=path.join(root,'source.pdf'), directory=path.join(root,'exports');
  fs.writeFileSync(source,'new processed bytes'); fs.mkdirSync(directory);
  const chosen=path.join(directory,'chosen.pdf'), other=path.join(directory,'other.txt');
  fs.writeFileSync(chosen,'old chosen bytes'); fs.writeFileSync(other,'private other bytes');
  const validator=createPathValidator(); validator.addAllowedPath(source);
  const handlers=new Map<string,Handler>();
  const showSaveDialog=vi.fn(async()=>({canceled:false,filePath:chosen as string|undefined}));
  const open=vi.fn((file: string,flags: string,mode?:number)=>fs.promises.open(file,flags,mode));
  const cleanup=vi.fn((directory:string,options:{recursive:boolean;force:boolean})=>fs.promises.rm(directory,options));
  const logger={log:vi.fn()};
  const fsImpl={...fs,promises:{...fs.promises,open,rm:cleanup}};
  registerCoreHandlers({
    ipcMain:{handle:(channel:string,handler:Handler)=>{handlers.set(channel,handler);}},
    app:{getPath:()=>root},dialog:{showSaveDialog},mainWindowProvider:()=>({isDestroyed:()=>false}),
    pathValidator:validator,fsImpl,logger,
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const call=async(channel:string,...args:unknown[])=>handlers.get(channel)?.({},...args);
  const select=()=>call('dialog:saveFile',{});
  const copy=(destination=chosen,from=source)=>call('file:copy',from,destination);
  return {root,source,directory,chosen,other,validator,select,copy,open,showSaveDialog,cleanup,logger};
}
describe('save dialog grants one exact destination',()=>{
  it.each(['sibling','descendant'])('rejects a %s destination without changing its bytes',async kind=>{
    const h=harness(); await h.select();
    const target=kind==='sibling'?h.other:path.join(h.directory,'nested','other.pdf');
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,'private bytes');
    await expect(h.copy(target)).rejects.toThrow();
    expect(fs.readFileSync(target,'utf8')).toBe('private bytes');
    expect(h.open).not.toHaveBeenCalled();
    await expect(h.copy()).resolves.toEqual({success:true});
  });
  it('consumes the exact destination once and requires a fresh save selection',async()=>{
    const h=harness(); await h.select(); await h.copy();
    await expect(h.copy()).rejects.toThrow();
    await h.select(); await expect(h.copy()).resolves.toEqual({success:true});
  });
  it('reserves consent before awaiting disk I/O, rejecting a concurrent duplicate',async()=>{
    const h=harness(); await h.select();
    let finish!:()=>void;
    h.open.mockImplementationOnce((file,flags,mode)=>new Promise((resolve,reject)=>{
      finish=()=>{fs.promises.open(file,flags,mode).then(resolve,reject);};
    }));
    const first=h.copy();
    await vi.waitFor(()=>expect(h.open).toHaveBeenCalledOnce());
    const duplicate=await Promise.allSettled([h.copy()]);
    finish(); await first;
    expect(duplicate[0].status).toBe('rejected');
  });
  it('keeps the old chosen file intact after a failed partial copy',async()=>{
    const h=harness(); await h.select();
    h.open.mockImplementationOnce(async(file,flags,mode)=>{
      const handle=await fs.promises.open(file,flags,mode);
      await handle.writeFile('partial'); await handle.close(); throw new Error('disk failed');
    });
    await expect(h.copy()).rejects.toThrow('disk failed');
    expect(fs.readFileSync(h.chosen,'utf8')).toBe('old chosen bytes');
    await expect(h.copy()).rejects.toThrow();
    await h.select(); await h.copy();
    expect(fs.readFileSync(h.chosen)).toEqual(fs.readFileSync(h.source));
  });
  it('replaces only the chosen hard-link name without changing its other name',async()=>{
    const h=harness(); fs.unlinkSync(h.chosen); fs.linkSync(h.other,h.chosen);
    await h.select(); await h.copy();
    expect(fs.readFileSync(h.other,'utf8')).toBe('private other bytes');
    expect(fs.readFileSync(h.chosen)).toEqual(fs.readFileSync(h.source));
  });
  it('does not grant any destination when the save dialog is cancelled',async()=>{
    const h=harness(); h.showSaveDialog.mockResolvedValueOnce({canceled:true,filePath:undefined});
    await h.select(); await expect(h.copy()).rejects.toThrow(); expect(h.open).not.toHaveBeenCalled();
  });
  it('revokes unused consent when a later save dialog is cancelled',async()=>{
    const h=harness(); await h.select();
    h.showSaveDialog.mockResolvedValueOnce({canceled:true,filePath:undefined});
    await h.select(); await expect(h.copy()).rejects.toThrow();
  });
  it('revokes the old target after choosing a different target',async()=>{
    const h=harness(); await h.select();
    h.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:h.other}); await h.select();
    await expect(h.copy()).rejects.toThrow();
    await expect(h.copy(h.other)).resolves.toEqual({success:true});
  });
  it('does not restore an old target when its dialog returns late',async()=>{
    const h=harness(); let finish!:(value:{canceled:boolean;filePath:string})=>void;
    h.showSaveDialog.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const old=h.select();
    h.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:h.other}); await h.select();
    finish({canceled:false,filePath:h.chosen}); await old;
    await expect(h.copy()).rejects.toThrow();
    await expect(h.copy(h.other)).resolves.toEqual({success:true});
  });
  it('does not spend the chosen grant on an unauthorized source',async()=>{
    const h=harness(); await h.select();
    await expect(h.copy(h.chosen,h.other)).rejects.toThrow();
    await expect(h.copy()).resolves.toEqual({success:true});
  });
  it('preserves ordinary overwrite and waits for the actual copy promise',async()=>{
    const h=harness(); await h.select(); let finish!:()=>void;
    h.open.mockImplementationOnce((file,flags,mode)=>new Promise((resolve,reject)=>{
      finish=()=>{fs.promises.open(file,flags,mode).then(resolve,reject);};
    }));
    let settled=false; const pending=h.copy().then(()=>{settled=true;});
    await vi.waitFor(()=>expect(h.open).toHaveBeenCalledOnce());
    expect(settled).toBe(false); finish(); await pending;
    expect(fs.readFileSync(h.chosen)).toEqual(fs.readFileSync(h.source));
  });
  it('rejects a symbolic-link target before changing its destination',async context=>{
    const h=harness(); fs.unlinkSync(h.chosen);
    try {fs.symlinkSync(h.other,h.chosen);}
    catch(error) {
      if(process.platform==='win32'&&['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){context.skip();return;}
      throw error;
    }
    await expect((async()=>{await h.select();await h.copy();})()).rejects.toThrow();
    expect(fs.readFileSync(h.other,'utf8')).toBe('private other bytes');
  });

  it('copies multiple buffers and removes old trailing bytes when replacing a larger file',async()=>{
    const h=harness(), bytes=Buffer.alloc(400123);
    for(let i=0;i<bytes.length;i++) bytes[i]=i%251;
    fs.writeFileSync(h.source,bytes); fs.writeFileSync(h.chosen,Buffer.alloc(500000,99));
    await h.select(); await h.copy();
    expect(fs.readFileSync(h.chosen)).toEqual(bytes);
    expect(fs.readdirSync(h.directory).some(name=>name.startsWith('.pdf-desensitization-'))).toBe(false);
  });
  it('cleans staging and preserves the old file when an opened destination write fails',async()=>{
    const h=harness(); await h.select();
    h.open.mockImplementation(async(file,flags,mode)=>{
      const handle=await fs.promises.open(file,flags,mode);
      if(flags==='wx') vi.spyOn(handle,'write').mockRejectedValueOnce(new Error('write failed'));
      return handle;
    });
    await expect(h.copy()).rejects.toThrow('write failed');
    expect(fs.readFileSync(h.chosen,'utf8')).toBe('old chosen bytes');
    expect(fs.readdirSync(h.directory).some(name=>name.startsWith('.pdf-desensitization-'))).toBe(false);
  });
  it('cleans staging and preserves the old file when a source read fails',async()=>{
    const h=harness(); await h.select();
    h.open.mockImplementation(async(file,flags,mode)=>{
      const handle=await fs.promises.open(file,flags,mode);
      if(flags==='r') vi.spyOn(handle,'read').mockRejectedValueOnce(new Error('read failed'));
      return handle;
    });
    await expect(h.copy()).rejects.toThrow('read failed');
    expect(fs.readFileSync(h.chosen,'utf8')).toBe('old chosen bytes');
    expect(fs.readdirSync(h.directory).some(name=>name.startsWith('.pdf-desensitization-'))).toBe(false);
  });
  it('revokes unused consent when the next dialog throws',async()=>{
    const h=harness(); await h.select(); h.showSaveDialog.mockRejectedValueOnce(new Error('dialog failed'));
    await expect(h.select()).rejects.toThrow('dialog failed'); await expect(h.copy()).rejects.toThrow();
  });
  it('does not permit another save dialog during an active physical write',async()=>{
    const h=harness(); await h.select(); let finish!:()=>void;
    h.open.mockImplementationOnce((file,flags,mode)=>new Promise((resolve,reject)=>{
      finish=()=>{fs.promises.open(file,flags,mode).then(resolve,reject);};
    }));
    const writing=h.copy(); await vi.waitFor(()=>expect(h.open).toHaveBeenCalledOnce());
    await expect(h.select()).rejects.toThrow('already in progress');
    expect(h.showSaveDialog).toHaveBeenCalledOnce();
    finish(); await writing;
  });
  it('rejects a directory target without authorizing an older file',async()=>{
    const h=harness(); await h.select();
    h.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:h.directory});
    await expect(h.select()).rejects.toThrow('regular file');
    await expect(h.copy()).rejects.toThrow();
  });
  it('allows a stable parent directory link and rejects a changed one',async context=>{
    const h=harness(), alias=path.join(h.root,'alias'), elsewhere=path.join(h.root,'elsewhere');
    const linked=path.join(alias,'chosen.pdf'); fs.mkdirSync(elsewhere);
    try {fs.symlinkSync(h.directory,alias,process.platform==='win32'?'junction':'dir');}
    catch(error) {
      if(process.platform==='win32'&&['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){context.skip();return;}
      throw error;
    }
    h.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:linked}); await h.select();
    await h.copy(linked); expect(fs.readFileSync(h.chosen)).toEqual(fs.readFileSync(h.source));
    h.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:linked}); await h.select();
    fs.unlinkSync(alias); fs.symlinkSync(elsewhere,alias,process.platform==='win32'?'junction':'dir');
    fs.writeFileSync(path.join(elsewhere,'chosen.pdf'),'unselected private file');
    await expect(h.copy(linked)).rejects.toThrow('directory changed');
    expect(fs.readFileSync(path.join(elsewhere,'chosen.pdf'),'utf8')).toBe('unselected private file');
  });


  it('reports a committed export as successful when only empty-directory cleanup fails',async()=>{
    const h=harness(); await h.select();
    h.cleanup.mockRejectedValueOnce(new Error('cleanup busy'));
    await expect(h.copy()).resolves.toEqual({success:true});
    expect(fs.readFileSync(h.chosen)).toEqual(fs.readFileSync(h.source));
    expect(h.logger.log).toHaveBeenCalledWith('Export completed; temporary directory cleanup failed','WARN');
    expect(h.validator.isResolvedPathAllowed(h.chosen)).toBe(true);
    await expect(h.copy()).rejects.toThrow();
  });
});
