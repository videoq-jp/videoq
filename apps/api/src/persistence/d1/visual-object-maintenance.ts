import { createVisualObjectCleanup, type VisualCleanup } from "./visual-objects";
import { isSafeMediaPath } from "../../shared/media-path";
export function visualObjectKeys(task:VisualCleanup):string[] {
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!isSafeMediaPath(task.file_key) || !uuid.test(task.run_id) || !uuid.test(task.object_version)) throw new Error("Invalid visual cleanup identity");
  const prefix=`${task.file_key}.visual-v2/${task.run_id}/`;
  if (task.kind==='manifest') return [prefix+`publications/${task.object_version}/overview.json`,prefix+`publications/${task.object_version}/manifest.json`];
  if (!Number.isSafeInteger(task.chunk_index) || task.chunk_index!<0 || task.chunk_index!>599) throw new Error("Invalid visual cleanup index");
  const key=`${prefix}${task.chunk_index}/${task.object_version}`;
  return [key+'.bin',key+'.json'];
}
export async function maintainD1VisualObjects(database:D1Database,remove:(key:string)=>Promise<void>,limit=5) {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>20) throw new Error("Invalid visual cleanup limit");
  const repo=createVisualObjectCleanup(database);
  const result={claimed:0,cleaned:0,failed:0};
  for (let i=0;i<limit;i++) {
    const task=await repo.claim();
    if (!task) break;
    result.claimed++;
    try {
      for (const key of visualObjectKeys(task)) await remove(key);
      if (await repo.complete(task)) result.cleaned++;
    } catch {
      await repo.retry(task);
      result.failed++;
    }
  }
  return result;
}
