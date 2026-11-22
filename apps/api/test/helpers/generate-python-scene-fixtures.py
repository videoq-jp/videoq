import json
import numpy as np
import tiktoken
from worker_python.use_cases.scene_splitting import SceneSplittingPolicy
from worker_python.pipeline.scene_otsu.splitter import SceneSplitter,l2_normalize
from worker_python.domain.scenes import scenes_to_srt_string
texts=['標本化は連続信号を離散化する。','量子化は値を有限の段階にする。','座標変換で画像を移動する。','回転と拡大を組み合わせる。','😀👩🏽‍💻漢字と改行\n次の行','<|endoftext|> is literal caption text.','a '*80,'日本語の字幕を安全に分割します。'*15,'� is an actual replacement character.']
rows=[]
for name,parts,limit in [('short',texts[:4],512),('otsu',texts[:4],23),('unicode',texts[4:5],8),('literal',texts[5:6],6),('long_ascii',texts[6:7],11),('long_japanese',texts[7:8],12),('replacement',texts[8:],5),('ties',texts[:4],18),('mixed',texts,30),('tiny',texts[4:5],1),('empty',[],10)]:
 srt='\n\n'.join(f'{i+1}\n00:00:{i*5:02d},000 --> 00:00:{(i+1)*5:02d},000\n{text}' for i,text in enumerate(parts))+'\n'
 vectors=[[1.,float(i%2),float(i%3)] if name!='ties' else [1.,0.,0.] for i in range(len(parts))]
 policy=SceneSplittingPolicy(tiktoken.get_encoding('cl100k_base'),lambda _:l2_normalize(np.array(vectors)),lambda v,s,e:SceneSplitter._find_otsu_threshold(None,v[s:e+1]))
 try:out=policy.process(srt,max_tokens=limit);row={'name':name,'transcript':srt,'maxTokens':limit,'vectors':vectors,'expected':out}
 except ValueError:row={'name':name,'transcript':srt,'maxTokens':limit,'vectors':vectors,'error':True}
 rows.append(row)
print(json.dumps(rows,ensure_ascii=False,indent=2))
