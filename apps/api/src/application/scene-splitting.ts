import { planSearchScenes, type SceneEncoding } from '../domain/search/search-scene-splitting';
export interface SceneSplittingDependencies {
  encoding: SceneEncoding;
  embed(texts: string[]): Promise<number[][]>;
  boundary?(start: number, end: number, texts: string[]): Promise<number>;
}


/** Execute the domain's bounded plan; external calls never run inside domain. */
export async function splitSearchScenes(transcript: string, deps: SceneSplittingDependencies, maxTokens = 512): Promise<string> {
  const plan = planSearchScenes(transcript, deps.encoding, maxTokens, !!deps.boundary);
  let step = plan.next();
  while (!step.done) {
    const effect = step.value;
    const value = effect.kind === 'embed' ? await deps.embed(effect.texts) : await deps.boundary!(effect.start, effect.end, effect.texts);
    step = plan.next(value);
  }
  return step.value;
}
