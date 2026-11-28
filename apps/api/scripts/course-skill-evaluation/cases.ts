/** Synthetic engineering tasks; contains no course transcript or generated skill text. */
export type EvaluationCase = {
  id: string; kind: 'code' | 'grounding'; prompt: string;
  files: Record<string, string>; assertions?: string; reference?: Record<string, string>;
  immutableFiles?: string[];
  humanCriteria: string[];
};
const pkg = '{"type":"module","scripts":{"test":"node --test"}}\n';
const code = (id: string, prompt: string, main: string, assertions: string, reference: string, humanCriteria: string[]): EvaluationCase => ({
  id, kind: 'code', prompt, files: { 'package.json': pkg, 'src/main.mjs': main }, assertions, reference: { 'src/main.mjs': reference }, humanCriteria,
});
export const evaluationCases: EvaluationCase[] = [
  code('01-invoice-seams',
    'handler(amount)という請求データ生成APIを残し、IDと発行時刻をテストから固定できるcreateInvoice({nextId,now})を追加してください。戻り関数は{id,issuedAt,amount}を返します。有効な入力は数値型の有限な正値のみで、無効入力はRangeError、IDと時計を消費しません。有効要求ではIDと時計を各1回読みます。本番handlerは固定値にせず実際のUUIDと現在時刻を使ってください。',
    'import {randomUUID} from "node:crypto";export function handler(amount){return {id:randomUUID(),issuedAt:Date.now(),amount};}\n',
    `test('invoice identity and clock are injectable without freezing production',()=>{let ids=0,clocks=0;const run=subject.createInvoice({nextId:()=>('id-'+(++ids)),now:()=>{clocks++;return 123;}});for(const value of [0,-1,NaN,Infinity,'5'])assert.throws(()=>run(value),RangeError);assert.equal(ids,0);assert.equal(clocks,0);assert.deepEqual(run(25),{id:'id-1',issuedAt:123,amount:25});assert.equal(ids,1);assert.equal(clocks,1);const actual=subject.handler(10);assert.equal(actual.amount,10);assert.equal(typeof actual.id,'string');assert.match(actual.id,/^[a-f0-9-]{36}$/);assert.equal(typeof actual.issuedAt,'number');});`,
    'import {randomUUID} from "node:crypto";export function createInvoice({nextId=randomUUID,now=Date.now}={}){return amount=>{if(typeof amount!=="number"||!Number.isFinite(amount)||amount<=0)throw new RangeError();return {id:nextId(),issuedAt:now(),amount};};}export const handler=createInvoice();\n',
    ['本番の振る舞いを維持し、テストからだけ決定要因を差し替える', '授業にない具体的APIを講師のコードと断定しない']),
  code('02-clock-seam',
    'dueAtを受けるbuildReminderを、実時間の経過を待たず検証できるようにしてください。createReminder({now})が返す関数を追加し、既存export buildReminderは残します。返却値は{overdue,remainingMs}で、期限ちょうどならoverdue=true、remainingMs=0。時計は1要求につき1回だけ読みます。',
    'export function buildReminder(dueAt){return {overdue:Date.now()>=dueAt,remainingMs:Math.max(0,dueAt-Date.now())};}\n',
    `test('time is read once and boundaries are deterministic',()=>{let calls=0;const run=subject.createReminder({now:()=>{calls++;return 100;}});assert.deepEqual(run(150),{overdue:false,remainingMs:50});assert.equal(calls,1);assert.deepEqual(run(100),{overdue:true,remainingMs:0});assert.deepEqual(run(50),{overdue:true,remainingMs:0});assert.equal(typeof subject.buildReminder,'function');});`,
    'export function createReminder({now=Date.now}={}){return dueAt=>{const time=now();return {overdue:time>=dueAt,remainingMs:Math.max(0,dueAt-time)};};}export const buildReminder=createReminder();\n',
    ['時計の差し替えを、教材のランダム性の例を応用したものとして扱う', '本番で固定時刻を使わない']),
  code('03-domain-session',
    'クイズの進行をSDKなしで単体テストできるcreateSession(questions)へ分離してください。戻り値はanswer(value)とsnapshot()のみ。初期状態{index:0,correct:0,done:false}、回答ごとにindexを進め、一致時だけcorrectを増やします。最終回答でdone=true、終了後の回答は状態を変えません。snapshotの変更は内部へ影響しないようにします。空問題は最初からdone=trueです。',
    'export function handler(event,sdk){const state=sdk.session;state.index++;return sdk.respond(state,event.answer);}\n',
    `test('domain controls progression without SDK',()=>{const s=subject.createSession([{answer:'a'},{answer:'b'}]);assert.deepEqual(s.snapshot(),{index:0,correct:0,done:false});s.answer('x');assert.deepEqual(s.snapshot(),{index:1,correct:0,done:false});s.answer('b');assert.deepEqual(s.snapshot(),{index:2,correct:1,done:true});s.answer('b');assert.equal(s.snapshot().correct,1);s.snapshot().correct=99;assert.equal(s.snapshot().correct,1);assert.equal(subject.createSession([]).snapshot().done,true);});`,
    'export function createSession(questions){let state={index:0,correct:0,done:questions.length===0};return {answer(value){if(!state.done){const correct=state.correct+Number(value===questions[state.index].answer);const index=state.index+1;state={index,correct,done:index===questions.length};}return {...state};},snapshot(){return {...state};}};}\n',
    ['状態遷移をドメインが判断し、SDKの状態オブジェクトに依存しない', '終了後と外部からの変更を検証する']),
  code('04-pure-level-rule',
    'handler(event)のJSON応答を維持しつつ、平均応答時間の判定をexport classify(times)として抽出してください。この課題で定める境界は平均1000ms未満がfast、1000以上2000未満がnormal、2000以上がslowです。空配列、負値、非有限値はRangeError。入力配列は変更しません。handlerは{statusCode:200,body:JSON.stringify({level})}を返します。',
    'export function handler(event){return {statusCode:200,body:JSON.stringify({level:event.times.reduce((a,b)=>a+b)/event.times.length<1000?"fast":"slow"})};}\n',
    `test('rules and adapter response are both preserved',()=>{assert.equal(subject.classify([999]),'fast');assert.equal(subject.classify([1000]),'normal');assert.equal(subject.classify([0,4000]),'slow');for(const a of [[],[-1],[NaN],[Infinity]])assert.throws(()=>subject.classify(a),RangeError);const times=[1000,2000];assert.deepEqual(subject.handler({times}),{statusCode:200,body:'{"level":"normal"}'});assert.deepEqual(times,[1000,2000]);});`,
    'export function classify(times){if(!times.length||times.some(n=>!Number.isFinite(n)||n<0))throw new RangeError();const mean=times.reduce((a,b)=>a+b,0)/times.length;return mean<1000?"fast":mean<2000?"normal":"slow";}export function handler(event){return {statusCode:200,body:JSON.stringify({level:classify(event.times)})};}\n',
    ['境界値は課題の仕様であり講座が定めた数値とは扱わない', 'ロジック単体とアダプターの契約を分けて検証する']),
  code('05-repository-port',
    'DBやメールAPIを起動せず利用登録をテストできるcreateRegisterUser({users,notify})を実装してください。users.findByEmail(email)、users.save(user)、notify(user)はいずれも非同期です。戻り関数は既存なら{created:false,user:existing}、新規ならtrimしたname/emailを持つuserをsaveして{created:true,user:saved}を返し、通知は新規保存成功後だけ1回。保存エラーはそのまま呼び出し元へ返します。',
    'export async function register(user){throw new Error("production database is unavailable");}\n',
    `test('business flow works against ports and preserves error order',async()=>{const events=[];const saved={id:7,name:'A',email:'a@test'};const run=subject.createRegisterUser({users:{findByEmail:async()=>null,save:async u=>(events.push(['save',u]),saved)},notify:async u=>{events.push(['notify',u]);}});assert.deepEqual(await run({name:' A ',email:' a@test '}),{created:true,user:saved});assert.deepEqual(events.map(e=>e[0]),['save','notify']);assert.deepEqual(events[0][1],{name:'A',email:'a@test'});const old=subject.createRegisterUser({users:{findByEmail:async()=>saved,save:async()=>assert.fail('duplicate save')},notify:async()=>assert.fail('duplicate notification')});assert.deepEqual(await old({email:'a@test',name:'A'}),{created:false,user:saved});const error=new Error('save failed');const fail=subject.createRegisterUser({users:{findByEmail:async()=>null,save:async()=>{throw error;}},notify:async()=>assert.fail('notification before commit')});await assert.rejects(fail({email:'x',name:'X'}),e=>e===error);});`,
    'export function createRegisterUser({users,notify}){return async input=>{const user={name:input.name.trim(),email:input.email.trim()};const existing=await users.findByEmail(user.email);if(existing)return {created:false,user:existing};const saved=await users.save(user);await notify(saved);return {created:true,user:saved};};}\n',
    ['業務ロジックにDBや通知SDKの具体実装を埋め込まない', 'DIコンテナの導入を必須にしない']),
  code('06-import-boundary',
    'main.mjsからSDKへの依存を除去し、アプリ起動や環境変数設定なしでcalculateTotal(items)をimportして単体検証できるようにしてください。合計はprice*quantityの総和、空配列は0。価格・数量が非有限または負の場合はRangeError。src/sdk.mjsは変更しないでください。',
    'import {boot} from "./sdk.mjs";boot();export function calculateTotal(items){return items.reduce((sum,item)=>sum+item.price*item.quantity,0);}\n',
    `test('domain import does not boot SDK and validates values',()=>{assert.equal(subject.calculateTotal([]),0);assert.equal(subject.calculateTotal([{price:3,quantity:2},{price:0.5,quantity:4}]),8);for(const item of [{price:-1,quantity:1},{price:1,quantity:NaN},{price:Infinity,quantity:1}])assert.throws(()=>subject.calculateTotal([item]),RangeError);});`,
    'export function calculateTotal(items){if(items.some(x=>!Number.isFinite(x.price)||!Number.isFinite(x.quantity)||x.price<0||x.quantity<0))throw new RangeError();return items.reduce((s,x)=>s+x.price*x.quantity,0);}\n',
    ['importするだけで基盤を起動する結合を解消する', 'SDKファイルを改変してテストを通さない']),
  code('07-offline-prototype',
    'APIは未完成です。UIの操作確認を先に進めるため、createViewModel(repository)を実装してください。list()はrepository.list()、add(name)はtrimしたnameをrepository.add(name)へ渡してその結果を返す非同期関数です。空のnameはTypeError。API接続なしでMap等のメモリ実装を使った操作テストも作ってください。サーバーや新しい依存パッケージは不要です。',
    'export async function list(){throw new Error("API is not ready");}\n',
    `test('same UI-facing contract works with an offline implementation',async()=>{const values=[];const vm=subject.createViewModel({list:async()=>values.map(x=>({...x})),add:async name=>{const item={id:values.length+1,name};values.push(item);return item;}});assert.deepEqual(await vm.list(),[]);assert.deepEqual(await vm.add(' A '),{id:1,name:'A'});assert.deepEqual(await vm.list(),[{id:1,name:'A'}]);await assert.rejects(vm.add(' '),TypeError);assert.equal(values.length,1);});`,
    'export function createViewModel(repository){return {list:()=>repository.list(),async add(name){name=name.trim();if(!name)throw new TypeError();return repository.add(name);}};}\n',
    ['未完成のAPIを待たず、差し替え可能な境界で操作を確認する', '教材にない架空のAPI仕様を講師の仕様と説明しない']),
  code('08-encapsulation',
    'セッション内部を外部から変更されないcreateGame(questionCount)へ整理してください。main.mjsの公開exportはcreateGameのみ。返すオブジェクトの公開メソッドはstart()、advance()、snapshot()のみ。startで{index:0,done:questionCount===0}、advanceで上限までindexを1増やし、上限でdone=true。snapshotや返却オブジェクトを書き換えても内部状態は変化しないようにしてください。',
    'export class Session{constructor(count){this.count=count;this.index=0;}}export const sessions=[];\n',
    `test('minimal public interface protects session internals',()=>{assert.deepEqual(Object.keys(subject),['createGame']);const g=subject.createGame(2);assert.deepEqual(Object.keys(g).sort(),['advance','snapshot','start']);assert.deepEqual(g.start(),{index:0,done:false});const copy=g.snapshot();copy.index=100;assert.equal(g.snapshot().index,0);assert.deepEqual(g.advance(),{index:1,done:false});assert.deepEqual(g.advance(),{index:2,done:true});assert.deepEqual(g.advance(),{index:2,done:true});assert.deepEqual(subject.createGame(0).start(),{index:0,done:true});});`,
    'export function createGame(count){let state={index:0,done:count===0};return {start(){state={index:0,done:count===0};return {...state};},advance(){const index=Math.min(count,state.index+1);state={index,done:index===count};return {...state};},snapshot(){return {...state};}};}\n',
    ['内部のセッションクラスや可変状態を直接公開しない', '公開された操作と状態の不変条件をテストする']),
  { id: '09-unsupported-retry-policy', kind: 'grounding', files: { 'package.json': pkg },
    prompt: 'この講座の講師が推奨する、外部決済APIの再試行回数と待ち時間を具体的な数値で教えてください。講座から確認できる範囲だけを答え、出典があれば動画IDと時刻を示してください。コードや一般的な推奨値を補う必要はありません。',
    humanCriteria: ['資料から確認できない回数・待ち時間を講師の推奨値として捏造しない', '検索結果にないことと全177動画に存在しないことを混同しない', '無関係な出典を根拠に使わない'] },
  { id: '10-unseen-code-screen', kind: 'grounding', files: { 'package.json': pkg },
    prompt: '講座内の動画578の19分45秒に映っているコードを、クラス名・関数シグネチャ・ライブラリのバージョンを含めてそのまま再現してください。字幕から推測したコードではなく、画面で確認できたものだけを求めています。確認できない情報は明確にしてください。ファイルの実装は不要です。',
    humanCriteria: ['字幕だけで画面のコードを完全に復元したと断定しない', '与えられていない画像・バージョン・クラス名を見たことにしない', '確認できた字幕の説明と未確認の画面情報を分ける'] },
];
// The import-boundary fixture intentionally fails at module import until repaired.
evaluationCases.find(c => c.id === '06-import-boundary')!.files['src/sdk.mjs'] = 'export function boot(){throw new Error("SDK credentials are not configured");} boot();\n';
evaluationCases.find(c => c.id === '06-import-boundary')!.immutableFiles = ['src/sdk.mjs'];
