"""Inspect the unchanged upstream image without a GPU or downloaded weights.

Always emit a machine-readable result, including when optional imports fail.
"""
import contextlib
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys



# Reviewed upstream vLLM tag 0.33.0, commit
# 4ba787ec9959e566d3b587a796dff07673324da5. Fail closed on image/source drift.
REVIEWED_VLLM_SOURCES = {'vllm/entrypoints/speech_to_text/base/serving.py': 'ea060ce1e3612ea056e1d6a3ef7bbd6291632290f10d48760520e9df22eb9299',
 'vllm/entrypoints/speech_to_text/base/utils.py': 'ab18a6bdf91d92bd87b86f9df90c8b81ed660b831416db41f3d8c2e80e2096e9',
 'vllm/entrypoints/speech_to_text/transcription/api_router.py': 'a9da965953b4dc1e4e9f40b27c89b2683db0f300a748fbabf84bb278dfe6ec0f',
 'vllm/entrypoints/speech_to_text/transcription/protocol.py': '354579ac9a05b28760f3c5401c367994bf9e84daf9ca833aa383f178efdcbe70',
 'vllm/multimodal/audio.py': '5a3f5c492e5ec6f9c213d0c2898b83573e39179a8cb8b6c9b920347e55ebf476',
 'vllm/multimodal/media/audio.py': 'cd88790d50e7feac9b94b89721cbf58e16dcf569020e4b08fa91da0efd6474e6'}
# Reviewed published PyAV19.0.2 rebuilt against FFmpeg9.1; all227
# installed av/ and av.libs/ members are pinned from the exact wheel bytes.
REVIEWED_PYAV_WHEEL_SHA256 = "75fd08d21f054bd7e1ca800f32799131926b43857e8fa2ffe43f8bc755043ffa"
REVIEWED_PYAV_WHEEL_SIZE = 3283767
REVIEWED_PYAV_WHEEL_URL = "https://github.com/videoq-jp/videoq/releases/download/videoq-audio-wheel-20261126-v1/av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl"
REVIEWED_FFMPEG_VERSIONS = {"libavcodec": (63, 24, 100), "libavdevice": (63, 5, 100),
                            "libavfilter": (12, 8, 100), "libavformat": (63, 16, 100),
                            "libavutil": (61, 19, 100), "libswresample": (7, 6, 100),
                            "libswscale": (10, 5, 100)}
REVIEWED_PYAV_MEMBERS = {'av.libs/libavcodec-603659c5.so.63.24.100': 'f8274bea318a7dfea4c9dd671d5a24bc246986d6689478ce5682266b1a007716',
 'av.libs/libavdevice-2c5bc585.so.63.5.100': 'c8af5cbfc77926aae4b56a64f37ceb6c556146bb18c2848d797d657a7636300c',
 'av.libs/libavfilter-2f2a3af1.so.12.8.100': '0adcc21afc98c846bf9981ac1a448d389abfe43ee2879905564882e8615a079d',
 'av.libs/libavformat-11e44de1.so.63.16.100': '78991a745910c4c990eeb31f3e32d4ee7584aed5fc85a364f6a38377ef85ddfd',
 'av.libs/libavutil-e158dbe9.so.61.19.100': 'e4d2d2c6a01da4a2671652cb32d3cf206f5060d8b74a4d48c584bc2de9544b09',
 'av.libs/libswresample-ddc57576.so.7.6.100': '5ceae7dac2b2b41ca217d17e5a80ff7a7368d2b631f6a217c81c51aefd408520',
 'av.libs/libswscale-0198d4e0.so.10.5.100': 'ad3f2c1fabb9084149558f030987db74759c1f21b78e5d8eb08aa325fe76a514',
 'av/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/__init__.py': 'cbf0c66e0a8ae53562da1245b185ae92d96f5ebeedfeaeb9df929156e0afc4cd',
 'av/__main__.py': 'c7ac8c31f2c65072e5cb6fcf958c2c1ebd5fb1922f69abb33d57b7640540b823',
 'av/_core.abi3.so': 'c7954ff241f5122f22f86db345c8501e6459f109dbe0cd3c76df33118e4d4804',
 'av/_core.pxd': '4d7500c180f6debe55b4d9542558a6cfe9f5ae2d9498371a717bf70a21f887c8',
 'av/_core.py': '3363a826de1f93181861734ebdbbe4f0eb15e03edd77782fd13661b35d3fdf00',
 'av/_core.pyi': '140944c2f6c6e078225e6ba99d6a62d6379b4d646a56f13c405393c5986a6e9d',
 'av/_cyutil.abi3.so': '8cbd6becf35b8cfdbdc3b760300f7637b77f695f5c6e33d316fe0ba795c875b2',
 'av/about.py': '1b23b78568ec9199122c5b3b388716379c69d21655b6d1c4d6f1a396bfec3ad5',
 'av/audio/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/audio/__init__.py': '70a8f0b60d5e3bd2d4adc522b7e10b1591f5c15b4fbfc3452e98b2b9f240ebcd',
 'av/audio/__init__.pyi': '92ba1c9a015006138f094f52a6160b92d7e2cf72af3421a11739f309cc80cc64',
 'av/audio/codeccontext.abi3.so': '55a5435bdb350c7f9214aa11cbadf47e5c1ae8ea2022ec6445ab1399de3b3388',
 'av/audio/codeccontext.pxd': '61fe8ac72251a37deffdc78aaea964e34e28b46b53bf1658faadd6fd321217a3',
 'av/audio/codeccontext.py': '333949a7facebf790cbfaf25379799df374a8d08e6380b99267b2e24aefdd1af',
 'av/audio/codeccontext.pyi': '110485639c20416ed9a9c60dc2460a763da7006d1adeea444bfded55861481a3',
 'av/audio/fifo.abi3.so': '25bb8ce02bddf4b9e7f0cad84955a70cf3c5ca476e36487d9620d7f464db8e88',
 'av/audio/fifo.pxd': '6533b8d0430fd797ced40766df8421e13ce04035de54b2c09f4f0342517943d7',
 'av/audio/fifo.py': '01d9d58668e4134aeef607fca493eec6c09974ab9e421dfa4b4314ad862eba5c',
 'av/audio/fifo.pyi': '23f9f33cc15ec678732dc3d9563150bc831ebf1ac41ec110c528ca98176f8781',
 'av/audio/format.abi3.so': 'e57075e7d3f3af1f61009778ee7911f2c91ac8032d699465b65db82adec6a21e',
 'av/audio/format.pxd': 'bc3c8735494eefa3ccf58a3c98cc4cc493ec6b6291260e1df7f2a5abce0f356e',
 'av/audio/format.py': 'da407c9dd2a410ba4dec4f34dca9d8d774350c3d0989002f626a9ecca85d2aa4',
 'av/audio/format.pyi': '4ab443819909f24ccab72c2ada1b656c928adddd9a7bd3c82fe41c9f2a2e8bcb',
 'av/audio/frame.abi3.so': 'dbc948a5444e6e3d764166fb02db145d843696493708a21a8f19549d9f5a0c2c',
 'av/audio/frame.pxd': '41b085c57321e4f4da0d5a260a130cc1cea21f54cfb1ddd8afb5a2225bf5d88c',
 'av/audio/frame.py': 'b9b53d7ea2721d5c265b1cc396df8213034dd7a9e4a1f10afff938079a36fcc1',
 'av/audio/frame.pyi': 'dce4c7c9a87ff322f84763d7001b75d89df0ed5ff765ff8125d5b19c964a0fbc',
 'av/audio/layout.abi3.so': '28a10d6bdc891721ac12d7b27b7e290a7e1dda66ce3c068ac1eeb6fcb25e4f47',
 'av/audio/layout.pxd': '6100e43efba418b21182f1e6585a4c2980aac9859ba4c66841d1a632ecbda5e1',
 'av/audio/layout.py': '6b793b0266a662a26d0a968d20099af5b3d37a9bdc780f1367be7b62484ed81f',
 'av/audio/layout.pyi': '71cd18f510ac7a2f36e075b0654b74d2d600bacf7614a8081ee524d3b969119c',
 'av/audio/plane.abi3.so': '13c43cd0cd3652b5e611555b86e92d680319924f4018a91a9346c37948542255',
 'av/audio/plane.pxd': '510645b6aba346c966e845def31a53cbc392a49bf4e2955162b8cc057821dee9',
 'av/audio/plane.py': 'b06adda97958f90c0879b6c0e2da295afb20eda00996d3af13d8d5a26c5fcaaa',
 'av/audio/plane.pyi': 'e92743b6ce4cd2df13a9eae065893afb9905cc8ed7075911d20e86997d3bd97a',
 'av/audio/resampler.abi3.so': '4a10df11a35afe2814df539970c6f0a0beaabe7912d97e383329524787986845',
 'av/audio/resampler.pxd': '940a4ade69a902b600cd09aeca970a3c6eb2e4b540b103a2d6f24c4e90fa42c0',
 'av/audio/resampler.py': '68299f15405bdc4d29d29ac2a13ee403ed6cf1a3340897c7b4f5d4b51526bfc3',
 'av/audio/resampler.pyi': 'd2e8106a0d8a6d9fa7a458bc60c4a482681b14f88fa414cd22c608a6c63c3056',
 'av/audio/stream.abi3.so': '76d7342fb261ae9edd84e5139790049d899973cec6eccb3c740ec68fa930dd0c',
 'av/audio/stream.pxd': '137f2535d66b56488d6d52d4268f2c82a14b4186ff5154e338b9a133e7236db8',
 'av/audio/stream.py': '6984239de8724d08f44e7453c7d5dc548994a4b817c8473639fae1b8a5a3f123',
 'av/audio/stream.pyi': 'f4e731579a8d0b0c4604dd6fae89a6bdb31f0f01edbae9843ecba3570db2b1b2',
 'av/bitstream.abi3.so': 'c958a72378bdee816646d8abcb1f7fd4d5fa8b246bc73eac758630291f462000',
 'av/bitstream.pxd': '862df493021d81d0901158ed52a5e8d8be208a81d4ff5ff25a02aedd2a828137',
 'av/bitstream.py': 'de84eb0bdb5a68cddbb4871ddfe7f2d4e33715398282b4658332afb66bf6e0ec',
 'av/bitstream.pyi': '8b4a46ac24cabc916c1a9a1a1884051e37e00fc773daf3bc83a9e1cbc66f8d3e',
 'av/buffer.abi3.so': '6e4209e6300ec27432c7548504e3eccb1430949014dd54ad1d137763f0fde834',
 'av/buffer.pxd': '2983d53880d567e4538feb523d1ad8c7218882b7a4297b779104aab996fa61cc',
 'av/buffer.py': 'd9c5226ebab12b58cf3d802a7a12f3618f116299437691ec3110f1073028b2f3',
 'av/buffer.pyi': '98175bda9808173a58a20514867b1a2568cc3d327e90017f3375c2449a00623a',
 'av/codec/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/codec/__init__.py': '557a3a46424e2fcae8edc3e00c767adb1dd3a9d1aa99970d5f77e45557fb95b3',
 'av/codec/codec.abi3.so': 'c5686207de40a42a7e6e291bb5ec74009a4990957c2f28efc6e31d3676e9163c',
 'av/codec/codec.pxd': 'da34bb84cabeb5ad534f6ed35ad775cfb6f9192f05fc31aa85f189f1193d057f',
 'av/codec/codec.py': '09aaf268141252c51e7c25c59ab8e7e1f99f4fb26076103f6fef228687c4428c',
 'av/codec/codec.pyi': '92076ba97708ad7e55f3f21a0549fd43961ebc6b9e713c9433a73908f3e3544c',
 'av/codec/context.abi3.so': '7a486eb62fa3524808440ba0c22728188bdd94f2426431abe2e6e1c79ccb4745',
 'av/codec/context.pxd': 'd7fb637f1a84dc173d822e0ca47dfa317299b4c4675bc1a17b16b6702601c052',
 'av/codec/context.py': '2c549fa68153f921f1da82d4f2cb83144e7fa3897202641c78d6babffee66f19',
 'av/codec/context.pyi': '983c120f599ef3c8c342e86453e68d96ce1fd0a2da4d836d30c33c9711d8093b',
 'av/codec/hwaccel.abi3.so': '84a912c83d011870e61fda2cbddb2e4eff573a15d6ff45be8f9baa763eadd4ac',
 'av/codec/hwaccel.pxd': 'be98d0709dc9b101a318b3986feb8fb3e405972aa30637759e951edac2afe96e',
 'av/codec/hwaccel.py': 'ac8e623ade96ebab0183da6d7ca37f99914c08204da865778294f0cde1334b77',
 'av/codec/hwaccel.pyi': '00e1892d1f08a72f9e7dd87fc998cdbf6e5cc18bc98cb9076ecfeb8ee3c6c077',
 'av/container/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/container/__init__.py': 'fc64e935e5f3d1ba3dde8b53677bfa7e14bddb7f198cea1b9f709142fd9d77de',
 'av/container/__init__.pyi': '3af1069d60715c6bae1951bd9fcada63c99f86c3b924a33b3e21bd345d711f34',
 'av/container/core.abi3.so': 'b611ea72784fea56e8ffcce91929fbf6bab76129b389094a12572fc6524297a0',
 'av/container/core.pxd': '89e8f7dc58eb3fc3162b8e625a9905812c3e32ea1999119284d382a3d6ea8a38',
 'av/container/core.py': 'c59c72bf9d52fc1d743012f10d2757b33dc4fe39639c92f5021c0cd7ee85122c',
 'av/container/core.pyi': '414e123a602825b2eaeb7a1ec1f21faac11a37f6d6345466abe16c392102a106',
 'av/container/input.abi3.so': '6e23a443a57172093d4e7c0e903482bacd959f0e1534cba25221ee72fc0fd546',
 'av/container/input.pxd': 'a15a5fa6daffcf69f0f6e3521c2d11fdf0be503d057fb3ad887ca77c09e5f907',
 'av/container/input.py': '0f5e9355627af62efcc75c8741cd2a865c2323ef69f510dd47b2acbf615cdffe',
 'av/container/input.pyi': '259bc8e4313d12aa9074236e2a7edd3cfe34b07f3847659f9766ae1f438cc025',
 'av/container/output.abi3.so': '8519a0919a9f2dc8fee30c657d5204fb314e9e65b6701faae4022326f8989ed4',
 'av/container/output.pxd': 'e6eedccec84cbc4064b78ac3cc7081b6397ecaec8d4895cb6994bac2cd63cf13',
 'av/container/output.py': '6728ee636e67d1f77edd64838462b9bb44134bd0123a11abc6db12044dc77837',
 'av/container/output.pyi': 'e1a3e83f102d2a219e6b8b187feab492c0aafec59525d0d38fa335e1af0174a7',
 'av/container/pyio.abi3.so': '17d486e50208bf58b67867c408c5d2600da7612d925719934cac82caf4cb1125',
 'av/container/pyio.pxd': '23709dd1b6f3286728ac55387366f32beeba9518d431f8c63d04c1044e1bb7f5',
 'av/container/pyio.py': '367ff1291700390fe0442335fd48f6d4edb610d6df7e2b889055acb594d25e84',
 'av/container/streams.abi3.so': '68d678f053a3e09b162cd8219afbe0da9348beb20bdf7a5c1dd8d4831d6db9c0',
 'av/container/streams.pxd': '569f32b05f772a1f09cfbf81375047a557836ae3ec062b599891fb820c99e420',
 'av/container/streams.py': '49735a4062d5e834f8324537d536c5cfb0824c628bc74af87e6e0bcb6bf5b3c0',
 'av/container/streams.pyi': '9d9571d53e08b728d349b18a909fc506175adaabd00c1abbaaea47398fa94b96',
 'av/datasets.py': '57bc291a57bff0041e4fcff409278658d84b4a34a1c98f890522116aeec7d7d7',
 'av/device.abi3.so': 'a44941727e242e37a1cb8e61bb7e46a88f0a760cbf63e9a98863d4a4d8a319c2',
 'av/device.py': 'a398c11071e92e956fa3c624a49a25507b38b98f5c1640defdd819682531171f',
 'av/device.pyi': '024dfd1cf4a81c6bad5b6518b7afe4c5c654ee2cef7a00197fc6b110ea6fdb4f',
 'av/dictionary.abi3.so': '9c70b4d24f06cba5735af796ac5488249c550a0227bf031a1af715be544b9c63',
 'av/dictionary.pxd': 'ccd3495bfcdf04a20b476ddfc1c51f7e15e32b64854b7d7a1ff6db6ca18e6b66',
 'av/dictionary.py': 'a1db02bb3dd83a7db5f88d08697e2d08f43d6d9dbcc4e58cf55176e4edc485b9',
 'av/dictionary.pyi': '0b03e10f46a3dfccfe00cc44441ed07cb733fd4436c587be9a773e6a564af005',
 'av/error.abi3.so': 'daec63d82b6ea6c30902dcecdeb81fa8c84fac1c0cc7cd2e830b32cd349e70b7',
 'av/error.pxd': 'a481726d5e9f042008dc8bde15532712fffd4bf7fcc6fd590b04581ef6cb6954',
 'av/error.py': '2985b32ed2677588b95a9fe7f04faa96c6848c307d8f29b8b5d99eaf130e1dcd',
 'av/error.pyi': '5af98822946b8ea838d185e92bae62d35b38f78cb90dde7f9c1afe4209a861e4',
 'av/filter/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/filter/__init__.py': 'dcf855420e5be763cc9806897f6a6630a6d2713be8edcbca49aff5669addd209',
 'av/filter/__init__.pyi': '2647e0efd86419d32ebc7339feb20afd8c8fd5f94926a9694ab57ac3ece7ce28',
 'av/filter/context.abi3.so': 'b5b2cc6c66e34d52d599f52d524a97b604ceb1c092b5d2aed8d0960796ae4eff',
 'av/filter/context.pxd': 'cc94805dd6aa15cc36af15585f0e7be689648c114a94bc7c5db92604561f97a4',
 'av/filter/context.py': 'dd971bf8f91a3e41b805f181e3d6359eff294ad5a1b6971fc30b1eaddef83eae',
 'av/filter/context.pyi': '0694028ada259bd9e544e6568058aab9fe25eaac310d09a4369fd78923f9cdac',
 'av/filter/filter.abi3.so': 'dc8e8eaff1023d29d16aa2390c2b0c5a2955ae5cc8a3bd06464335a7c2fd5795',
 'av/filter/filter.pxd': '83026882f311784dbb3db987e846e539727f2cbed9f310b8f6c7c717c18ec729',
 'av/filter/filter.py': 'd9dca743ca382ab0b257ea0cc6ea5d8951a0ef2dcbd0973fc239669d5d3263c7',
 'av/filter/filter.pyi': 'cfb4249953be7443046d7f31231fa575defb46af3a4b83ac5a9276bd61525c0f',
 'av/filter/graph.abi3.so': '0937d38e4e17d3aea7f989fabe2b18d64390e000d3c38c645a2f7a5ad802ebb8',
 'av/filter/graph.pxd': 'e3c31691d8c7617fca81aa23f433696f550d58fbc394b8ff04d1c934f0d9e487',
 'av/filter/graph.py': '02bbf1475d433af3d64782f45db2f802fc12f47f377465eb111425ceddabe770',
 'av/filter/graph.pyi': '8032d7226ad73dbef732d49ea9b473d18397a59542db996589b793c75d22b609',
 'av/filter/link.abi3.so': 'b77b377d1b727270bf8114f106c72954a9c8640013ce75b30566c7d4abb8a535',
 'av/filter/link.pxd': 'c8ae6ac7ce7a3da4b239828a1074afb1177234720bc0e5a28d48ef8c9a9ea037',
 'av/filter/link.py': 'beae819eb04c45e16f3318e4d0a40cd8ffab42a53701a8644a52dd6a61d349e4',
 'av/filter/link.pyi': 'd863f15865ab95cad03b155a2e44fe5b0dae2ec31777acbfbf2b617827a1924d',
 'av/filter/loudnorm.abi3.so': '0e95983dff22f40552af35da01bf5dbf80ba9b4680dd0c74c617e620b13095d1',
 'av/filter/loudnorm.pxd': '9ab2a21927ba5a722b3240c953cba3d5fb34230cff93114f0cbfcd9a7bdec941',
 'av/filter/loudnorm.py': '993c95a8d915666074ec0671dc4ce18747d10988b48783f69aa214f8dfa8556f',
 'av/filter/loudnorm.pyi': '37f1ee5e94254da64ba672a37ea324ebc69cddd8f299dcb7c7ff5e9f7dec03be',
 'av/filter/loudnorm_impl.c': '88b6d687cb826d8ab3c9ca1e4f007654408223c98e860221f9932f49b44177a0',
 'av/filter/loudnorm_impl.h': '42652a9efa1b31b3d299ab3985a7aff3a582540b3f6ba89768064fc31fa25409',
 'av/format.abi3.so': '7d95d51b478f985fef94b77b0ad4203f289f67c2d4cad0a6b4895cb66c5777c8',
 'av/format.pxd': '55b08f2ea75be3dcc64a239dc9ce2793521003b243d550a1172b219a357c9aee',
 'av/format.py': '09c3d107d350af78f09aa1b675cf844c6992c5c5e941f2bd89b6ba2a565809a2',
 'av/format.pyi': '82af9d95e9108bc97656e23a31df4064654ae8040ac152566859e789ae0c1656',
 'av/frame.abi3.so': 'b3ac17531f14e6a3b660c350272b8f39635f0337254280e26c2e000afdc6f067',
 'av/frame.pxd': 'ddb8b2f3a6c985b53ec6060c799f5cf046f961fccff545e5e1659cc709c2274e',
 'av/frame.py': '8bb7aa232f8021552e33ee6efe68f9e02ddc07b4169b7786bcb159eacd616db5',
 'av/frame.pyi': '9ab1eed5c8fd19325f9e2bbaca5aca8448a7451786dd30743497c85e0b63fd38',
 'av/index.abi3.so': 'd936fabb54a4468580db20e4e09addb87f6c2ab6bd28ba490cbd122e0bf2cf86',
 'av/index.pxd': '844ab87c60825819eea3f5c61397d11afd0d838242bc59ccf4a018f6417e1f2b',
 'av/index.py': '4feb88e20adb90ccfe38bf86d7f50408d405c90bbf1c0cd75a16c36e83aa5467',
 'av/index.pyi': 'b0d171d701ca6cfe8c52ddb18173d2ff5346cf19d725b6c123f6fc2afb65961c',
 'av/logging.abi3.so': 'c6b78e2cfbaf6248bd130f09021a58630b4e9e5bcd09cc0a870a2005f2aadc78',
 'av/logging.pxd': 'b45a5e897b801f2a7a6e1074a419e6a47a86de02f79975b8a4d97a4925d078d2',
 'av/logging.py': 'ab0ef0cbacbe64d26333a7b470a3e9da66670fa453df3b6a105e951cadff27a2',
 'av/logging.pyi': '2c0dc6174f6c4ddd3a0895f6b6aa78deebb0663edaeb4cfd6521d65f66865e20',
 'av/opaque.abi3.so': '0d2c8ba708af4ee9c7e67d835d72189718d7c0a257f3e6ecec429d2757cd0859',
 'av/opaque.pxd': '3e112e6880d3619e8dbc4454a1742db928803323643ac02315e37f27a291c2ae',
 'av/opaque.py': '971ea77f8af9c26865e999059cd1bf0dcd9e59b376bc300f8a7e8b61e2a512fa',
 'av/packet.abi3.so': '9728aa2356d9a592f4b1d4e994a53fc542c8ca790b709092dfb4d00f547581c5',
 'av/packet.pxd': 'd1d8142aa239a2fedae8be0622c8faf170ae0aa9b4f51a9bfa5846a22b36f1ec',
 'av/packet.py': 'bf5e62c3481c0d58c91e2b1806cfca4fa43e7b3c287a18f04d219cd9be723afb',
 'av/packet.pyi': 'b2c38674dc4482ff73911cfedef25fc8167bab6c00af87f1981d1fd7c3108ba3',
 'av/plane.abi3.so': '194126de9d1ee02a0376cff126732292ac3c478a9b889f1415c2c5c3283176fb',
 'av/plane.pxd': '78ece33da08356fbdaca01e24d79a6e3beff6e6c196796c3a3882a299733bf11',
 'av/plane.py': '14509fcc24b75e6ce342e1e31619965ad3e4a313088abb33f8ef7cd021a7fa74',
 'av/plane.pyi': 'a892f0eccef77a44e15dfd392ea4e595fd412c87c5de0724c44cbaac48cac785',
 'av/py.typed': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/rational.abi3.so': 'a3faa19412da3e65a503785db31728ef88b34073b63bff2f6a1d3ecb7548e571',
 'av/rational.pxd': 'bff25ff827162948563fd7b588e3c47cc71db089f45271a213e8d0d2ce3053b0',
 'av/rational.py': '7a614d4b57396973ac0315af1cb007b38690d3d384984080936db72150f9483c',
 'av/rational.pyi': '9928c2758008187a564c3705c0d6911f41070f8a29faed26605e96b167c41cd3',
 'av/sidedata/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/sidedata/__init__.py': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/sidedata/encparams.abi3.so': '32e982e62684632d25d149bbb4e5d5deac2cb2cd371610017c549a607d9815e4',
 'av/sidedata/encparams.pxd': 'd68bc03a32192b00a6f4a57f971b58f64994a8dbaec26588d2792d7f886245ed',
 'av/sidedata/encparams.py': '1b7ace9b4fba3e6d83f55dbdc76162c1c2e4ab7e338f7e4aeb9cf918846a36f5',
 'av/sidedata/encparams.pyi': '05e6d3746aaaccd2d8f3fee192b5b6a685d632e21e6383be90149756f874994a',
 'av/sidedata/motionvectors.abi3.so': 'c8b72cda0d46e98758fe6194ebf7187cb3a4ca6d9a85d0099dbc2b566ecae25e',
 'av/sidedata/motionvectors.pxd': 'c089eaf55743e1dda0f931a8c9217985beedea606fc774e1fcefc604db3cea56',
 'av/sidedata/motionvectors.py': '0779c046d5581fba7e93348eba99d881f30767836570a5881e92f6ed8d0be8e4',
 'av/sidedata/motionvectors.pyi': '3894eaa4c57db0df6d6824f898f1d2e9785067715cc943a96381993109ea668b',
 'av/sidedata/sidedata.abi3.so': '229191ab0d0dd33923f65789e83fd9e41868fb2b59a72e3d0802f1383eaba9f2',
 'av/sidedata/sidedata.pxd': '776c2e53fba2bb47ebffdbffad8c3ab3c3f4ec3294379cae2034068bddc9a8f8',
 'av/sidedata/sidedata.py': 'bd0605cbcccd98d96b8c0f95a475117935ca6d8f05d6e3708e69925079377729',
 'av/sidedata/sidedata.pyi': 'e8691453863077952fc4afd948bcf4e2d6c7d54c1b6c14b7cd6ad259248f535b',
 'av/stream.abi3.so': '4cb9f8d2c234f37481919a3b3d5cf0f881364ceae083ff73592be44e812f418b',
 'av/stream.pxd': '316259f253780087aac224ee40260ffc70d6a6beeb1305b67f451ab57fa8a43d',
 'av/stream.py': 'bd6e8fdd70e114f29d2bf6a2d830269eea1e68934c85e893971ed79d08cd95f5',
 'av/stream.pyi': '7bd72c1a80e5771ed3ca22bc36f9f3bb550d28610cfcbd12969d9f978dc8cb23',
 'av/subtitles/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/subtitles/__init__.py': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/subtitles/__init__.pyi': '366dee5ce70dd9b729323765017b7058b94c215a6654c45170bf6b242bcf17c1',
 'av/subtitles/codeccontext.abi3.so': '1a340b09032cce470b455a4f892155de6d4471cb47b3fd95f98a7dfa0af39be5',
 'av/subtitles/codeccontext.pxd': '1f1b495148a154cefae7fd833986cb5b6e52362c9ccd35d8c6e25779576353e1',
 'av/subtitles/codeccontext.py': '7209af0efbb266c0be9b1cfa950440d3de17426098dae6e826f8a054ebbcece7',
 'av/subtitles/codeccontext.pyi': '1dc3eecd1e41bb00f43e1e0e9d41df2145c916a7ae37aa63a35374f3ceafd1aa',
 'av/subtitles/stream.abi3.so': 'e6400afee14a8124a7cc0e41219d3e3b0619af6ad6b74f34f7746a6b1bf4eddd',
 'av/subtitles/stream.pxd': '2e8e110534ce584af32a036a734ec0a0d0da020914b05fd0db90c9680228e766',
 'av/subtitles/stream.py': '54d50b3e0b7639faf3c132f00b41a814ff7661282633ae00b6c3ea8a9a444553',
 'av/subtitles/stream.pyi': 'f8c34f41ea8f1b874c53321f07a5eff6516f3594a5f0acb23b84621eb99fc9b9',
 'av/subtitles/subtitle.abi3.so': '69acb5f24496201619e1e9e607784087eff912c3e2ef63e3d4cd17c9db714ed9',
 'av/subtitles/subtitle.pxd': '37f4305e8e648a675963e4f64b1228c1192a883dfca870383048ce6990fad7d0',
 'av/subtitles/subtitle.py': '603d5233d8f350881493d79083fb5d5a69c02ebf8ae3fc9fbf1e3d532b2672e0',
 'av/subtitles/subtitle.pyi': '5c1f471500a757e3aa67408499af8eb4f44072c272ea15486f7e2cea3ce8d80d',
 'av/utils.abi3.so': 'e7c280ac296849196e2a139701c65b95f5ecf3859b5c08b6c8fd4e327a400ec5',
 'av/utils.pxd': '997978c9f28aa07e2f56170459c3283d0292036d302b1395e191e8584057f82e',
 'av/utils.py': 'faa38f8aee59d22384a172bf38bf5506bbc9dfe7ec6a58c29c19a1b8cca3fa97',
 'av/video/__init__.pxd': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'av/video/__init__.py': '56adfde8becf3233214c386f1593db70ba94f6681d011f363569352b4f101fae',
 'av/video/__init__.pyi': '0b69d89b7e4ef06b7b95881b1f3b3613a5237e5797685101b484d457b1b967ed',
 'av/video/codeccontext.abi3.so': '902ec9ec55936079976a5d6f6bc6b4e4ce04021b1f2e526d4de3659299165337',
 'av/video/codeccontext.pxd': '8e36184f85b6e4f74dbfe9dd9a4f3fdfdad8c8595138f49a9d011d753ba482ef',
 'av/video/codeccontext.py': 'bdb4a6d10f99c8e188c821ff0fb1d5c24572996ac9da9e06750803fe7ca93bbc',
 'av/video/codeccontext.pyi': '0411d91a3fe5df8b2ac7130f8ec2763439c93dc3af0c7db3c21f8cafc27c2d1f',
 'av/video/format.abi3.so': 'ae579fd9a426ebce60e5e4b658c6a9f8822d9b1975cffdb39ac24acf954c852d',
 'av/video/format.pxd': 'fb016e4e9e304aa1c4d77b05500105a9929c0d9627c7146f275cf0dfc0d39690',
 'av/video/format.py': '7d37f8545c22895e5d25826bfda3f237e8001f0d8cf447135b16b2b0e75eb49d',
 'av/video/format.pyi': '55c7a38792dec7f2e30b9888248d9929f05e47925e846030d626be5cd145b9c8',
 'av/video/frame.abi3.so': 'faf0acbd5a2f165af7c1f43205c24c7e474559e7fcd852f0a6d17586c43fe269',
 'av/video/frame.pxd': '8c45b20c503a5cbc53cbc198155b0e223f0ccec46362cf223da86ab99b0a2877',
 'av/video/frame.py': '4f9f2377dba3405f87703bb83f677954b03cad8207e674eeb399b212e05577c2',
 'av/video/frame.pyi': '7c41ac7c2674baadc4c61b94507947951f58f195133d3bfb0290f96b2fff3488',
 'av/video/plane.abi3.so': 'b0d3f1112b524560e3b1c5a8b5829717711c1ac1222c75699adac2b8e662d5f3',
 'av/video/plane.pxd': '837aa3c7afb5712941367152d8c89fe220640ff56f1c0f760ff4af6d44dddc36',
 'av/video/plane.py': '6a1a370502dae6fc42cbe6234c0c8a78bfe75c8e7f91165f252b7ffb3226a7e7',
 'av/video/plane.pyi': 'dba858cc2eb710ddf5a45c91dc64e775fe6e61ce37bc7db358c6972d2ff0325d',
 'av/video/reformatter.abi3.so': 'badd062c364dfc913f978ed1f4a8fe691896b4010d6f8be1e22215360affbce1',
 'av/video/reformatter.pxd': '27de4304861672be80ea36dfa174f2b7f2b51e5da596e86fbedb42bdc39b4976',
 'av/video/reformatter.py': 'fd1cbb00c44795743319b540aa73bafb6cadbd00e565c0cd38917474e28a0bb5',
 'av/video/reformatter.pyi': '417ef77505c5bd2bc76e48fa8955cb279be5e5451040bf7f8f8138258ea2fc0e',
 'av/video/stream.abi3.so': 'e026e8226e22fea0346407d69c1a6b1c7390dde494d1c2d1addc88788317fa7c',
 'av/video/stream.pxd': '9cb5ed4d827e7b208eea550ad4e159115ed445cdf1fb9e4156057108a83ab1f8',
 'av/video/stream.py': 'dc5c0c5c4735e33789e9f9ea1ed57776b5831b7a3040f3050ed10dbd6a04883d',
 'av/video/stream.pyi': '6ee7567d1d23dd45e71d7fbabbd65f40339baf50df59469f9aae07468bcde292'}

def verify_reviewed_files(root, expected):
    """Never substitute version labels for the installed files' identities."""
    root = Path(root).resolve()
    observed = {}
    for relative, digest in expected.items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Reviewed source escaped its package root")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            raise ValueError(f"Unreviewed installed source/native member: {relative}")
        observed[relative] = actual
    return observed


class AudioBoundary:
    """Observe Python->native calls, without pretending to trace Cython cimports.

    Used only around the probe's calls, never installed into the serving image.
    Unknown attributes fail closed. The native AudioResampler's internal graph
    remains separately identified by immutable wheel hashes, not monkeypatches.
    """
    def __init__(self, native):
        self.native = native
        self.calls = []
        self.error = native.error
        self.AudioFrame = native.AudioFrame

    def open(self, file, *args, **kwargs):
        from io import BytesIO
        if args or not isinstance(file, BytesIO) or kwargs:
            raise ValueError("Unexpected native input/output/options boundary")
        self.calls.append({"operation": "av.open", "mode": "r", "input": "BytesIO"})
        return self.native.open(file)

    def AudioResampler(self, *args, **kwargs):
        if args or kwargs != {"format": "fltp", "layout": "mono", "rate": 16000}:
            raise ValueError("Unexpected native resampler/filter options")
        self.calls.append({"operation": "AudioResampler", **kwargs})
        return self.native.AudioResampler(**kwargs)

    def __getattr__(self, name):
        raise ValueError(f"Unexpected PyAV API at serving boundary: {name}")


REVIEWED_MASKED_FFMPEG_PATHS = ('/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavcodec.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavcodec.so.', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavcodec.so.62', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavcodec.so.62.28.101', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavdevice.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavdevice.so.62', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavdevice.so.62.3.101', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavfilter.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavfilter.so.', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavfilter.so.11', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavfilter.so.11.14.101', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavformat.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavformat.so.', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavformat.so.62', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavformat.so.62.12.101', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavutil.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavutil.so.', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavutil.so.60', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libavutil.so.60.26.101', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libswresample.so', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libswresample.so.6', '/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec/libswresample.so.6.3.101', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs/libavcodec-c4204469.so.62.28.101', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs/libavformat-4762a711.so.62.12.101', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs/libavutil-befbbc48.so.60.26.101', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs/libswresample-2dfded3b.so.6.3.101')
REVIEWED_NATIVE_MASKS = ('/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs', '/usr/local/lib/python3.12/dist-packages/mooncake', '/usr/local/lib/python3.12/dist-packages/torchcodec')


def verify_native_masks():
    for value in REVIEWED_NATIVE_MASKS:
        path = Path(value)
        if path.is_symlink() or not path.is_dir() or list(path.iterdir()):
            raise ValueError(f"Unused native library directory is not masked: {value}")
        if os.access(path, os.W_OK):
            raise ValueError(f"Native mask must be read-only: {value}")
    return list(REVIEWED_NATIVE_MASKS)


def verify_torchcodec_mask():
    """The optional engine must be an empty namespace, never cached native code."""
    import importlib.util

    verify_native_masks()
    directory = REVIEWED_NATIVE_MASKS[3]
    if any(name.startswith("torchcodec.") for name in sys.modules):
        raise ValueError("Preloaded TorchCodec submodule invalidates native exclusion")
    spec = importlib.util.find_spec("torchcodec")
    if (spec is None or spec.origin is not None
            or list(spec.submodule_search_locations or []) != [directory]
            or (spec.loader is not None
                and not isinstance(spec.loader, importlib.machinery.NamespaceLoader))):
        raise ValueError("TorchCodec root must be the exact empty masked namespace")
    module = importlib.import_module("torchcodec")
    if (getattr(module, "__file__", None) is not None
            or list(getattr(module, "__path__", [])) != [directory]
            or not isinstance(getattr(module, "__loader__", None), importlib.machinery.NamespaceLoader)):
        raise ValueError("Executable or alternate preloaded TorchCodec root")
    denied = []
    for name in ("torchcodec.decoders", "torchcodec._core", "torchcodec._core.ops"):
        try:
            candidate = importlib.util.find_spec(name)
        except ModuleNotFoundError as error:
            if error.name not in (name, "torchcodec._core"):
                raise ValueError("Unexpected TorchCodec dependency lookup") from error
            candidate = None
        if candidate is not None:
            raise ValueError(f"TorchCodec executable submodule remains visible: {name}")
        try:
            importlib.import_module(name)
        except ModuleNotFoundError as error:
            if error.name not in (name, "torchcodec._core"):
                raise ValueError("Unexpected TorchCodec dependency import") from error
            denied.append(name)
        else:
            raise ValueError(f"TorchCodec executable submodule imported: {name}")
    return {"root": "empty_namespace_only", "path": directory, "importsDenied": denied}


def verify_masked_native_denial(audio_root):
    """Only constant reviewed paths are probed; no report-provided code is loaded."""
    import ctypes
    import importlib.util

    verify_native_masks()
    torchcodec = verify_torchcodec_mask()
    before = loaded_ffmpeg_libraries(audio_root)
    imports = []
    for name, directory in (("PyNvVideoCodec", REVIEWED_NATIVE_MASKS[0]),
                            ("opencv_python_headless", None),
                            ("mooncake", REVIEWED_NATIVE_MASKS[2])):
        spec = importlib.util.find_spec(name)
        if spec is not None:
            # Empty masked directories can produce namespace packages. They
            # contain no executable module and may not merge an unmasked path.
            locations = list(spec.submodule_search_locations or [])
            if (spec.origin is not None or locations != [directory]
                    or (spec.loader is not None
                        and not isinstance(spec.loader, importlib.machinery.NamespaceLoader))):
                raise ValueError(f"Executable or alternate masked module import: {name}")
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as error:
            if error.name != name:
                raise ValueError(f"Masked module executed dependency imports: {name}") from error
            imports.append({"module": name, "result": "not_found"})
        else:
            if (spec is None or getattr(module, "__file__", None) is not None
                    or list(getattr(module, "__path__", [])) != [directory]):
                raise ValueError(f"Masked executable module imported: {name}")
            imports.append({"module": name, "result": "empty_namespace_only"})
    denied = []
    for value in REVIEWED_MASKED_FFMPEG_PATHS:
        if not any(value.startswith(mask + "/") for mask in REVIEWED_NATIVE_MASKS):
            raise ValueError("Reviewed native load target outside masks")
        try:
            ctypes.CDLL(value)
        except OSError:
            denied.append(value)
        else:
            raise ValueError(f"Masked native library loaded: {value}")
    after = loaded_ffmpeg_libraries(audio_root)
    if before != after:
        raise ValueError("Loaded FFmpeg mappings changed during denied-load probe")
    verify_native_masks()
    return {"imports": imports, "torchcodec": torchcodec,
            "absoluteLoadsDenied": denied, "loadedFfmpeg": after,
            "nativeFilterTraceComplete": False}


def loaded_ffmpeg_libraries(audio_root, maps_path="/proc/self/maps"):
    """Detect an alternate loaded FFmpeg copy in the offline Linux native job."""
    root = Path(audio_root).absolute()
    approved = root / "av.libs"
    paths = set()
    for line in Path(maps_path).read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 6 or not fields[5].startswith("/"):
            continue
        path = Path(fields[5])
        if path.name.startswith(("libavcodec", "libavformat", "libavfilter", "libavutil",
                                 "libavdevice", "libswresample", "libswscale")):
            try:
                resolved = path.resolve(strict=True)
                relative = resolved.relative_to(root).as_posix()
                # A maps entry must name the exact existing reviewed member,
                # not a deleted mapping, symlink alias or same-directory copy.
                if (str(resolved) != fields[5] or not resolved.is_relative_to(approved)
                        or not resolved.is_file() or relative not in REVIEWED_PYAV_MEMBERS
                        or any(part.is_symlink() for part in (path, *path.parents))):
                    raise ValueError("Mapped path is not an exact regular reviewed member")
                if hashlib.sha256(resolved.read_bytes()).hexdigest() != REVIEWED_PYAV_MEMBERS[relative]:
                    raise ValueError("Mapped member hash drift")
            except (OSError, ValueError) as error:
                raise ValueError(f"Unreviewed loaded FFmpeg library: {path}") from error
            paths.add(str(resolved))
    if not paths:
        raise ValueError("No actual FFmpeg library mapping observed")
    return sorted(paths)


def ffmpeg_mapping_snapshot(maps_path="/proc/self/maps"):
    """Diagnostic paths only, never library approval or a replacement for hashes."""
    paths = set()
    for line in Path(maps_path).read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) == 6 and Path(fields[5]).name.startswith(
                ("libavcodec", "libavformat", "libavfilter", "libavutil",
                 "libavdevice", "libswresample", "libswscale")):
            paths.add(fields[5])
    return sorted(paths)


def reference_pyav_decode(native, raw, target_rate=16000):
    """Record the exact emitted prefix and flushed reference independently."""
    import io
    import numpy as np

    prefix = []
    tail = []
    with native.open(io.BytesIO(raw)) as container:
        stream = container.streams.audio[0]
        resampler = (native.AudioResampler(format="fltp", layout="mono", rate=target_rate)
                     if stream.rate != target_rate else None)
        for frame in container.decode(stream):
            frames = resampler.resample(frame) if resampler else [frame]
            prefix.extend(output.to_ndarray() for output in frames)
        if resampler:
            tail.extend(output.to_ndarray() for output in resampler.resample(None))
    def mono(chunks):
        array = np.concatenate(chunks, axis=-1).astype(np.float32)
        return np.mean(array, axis=0) if array.ndim > 1 else array
    emitted = mono(prefix)
    complete = mono(prefix + tail)
    return emitted, complete


def verify_pyav_prefix(waveform, decoded_rate, emitted, complete):
    import numpy as np

    if (decoded_rate != 16000 or waveform.ndim != 1 or waveform.dtype != np.float32
            or not np.isfinite(waveform).all() or complete.ndim != 1
            or complete.size != 1600 or not np.isfinite(complete).all()
            or emitted.size == 0 or emitted.size > complete.size or waveform.shape != emitted.shape
            or not np.allclose(waveform, emitted, rtol=0, atol=1e-6)
            or not np.allclose(emitted, complete[:emitted.size], rtol=0, atol=1e-6)):
        raise ValueError(f"Actual PyAV reference mismatch: rate={decoded_rate}, "
                         f"shape={waveform.shape}, emitted={emitted.size}, full={complete.size}")
    return {"decodedRate": decoded_rate, "emittedSamples": int(emitted.size),
            "fullReferenceSamples": int(complete.size),
            "bufferedTailSamples": int(complete.size - emitted.size),
            "upstreamFallbackFlushesResampler": False}


def verify_auto_serving_waveform(chunks, duration, normalized_reference):
    import numpy as np

    if (len(chunks) != 1 or chunks[0].ndim != 1 or chunks[0].size != 1600
            or not np.isfinite(chunks[0]).all() or not np.isfinite(duration)
            or abs(duration - .1) > .001 or normalized_reference.shape != (1600,)
            or not np.allclose(chunks[0], normalized_reference, rtol=0, atol=1e-6)):
        raise ValueError("Actual auto-serving waveform/normalization/duration mismatch")


def verify_pyav_release(native, receipt):
    packages = [package for package in receipt["manifest"]["packages"] if package["name"] == "av"]
    if len(packages) != 1:
        raise ValueError("Exactly one reviewed PyAV wheel receipt is required")
    package = packages[0]
    expected = {"name": "av", "version": "19.0.2", "ffmpegVersion": "9.1",
                "filename": "av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl",
                "url": REVIEWED_PYAV_WHEEL_URL, "sha256": REVIEWED_PYAV_WHEEL_SHA256,
                "size": REVIEWED_PYAV_WHEEL_SIZE}
    if any(package.get(key) != value for key, value in expected.items()):
        raise ValueError("Unreviewed PyAV release wheel receipt")
    if (native.__version__ != "19.0.2" or native.ffmpeg_version_info != "9.1"
            or native.library_versions != REVIEWED_FFMPEG_VERSIONS):
        raise ValueError("Unreviewed loaded PyAV/FFmpeg library versions")
    return {"pyavVersion": native.__version__, "ffmpegVersion": native.ffmpeg_version_info,
            "wheelSha256": REVIEWED_PYAV_WHEEL_SHA256, "libraryVersions": native.library_versions}


def inspect_serving_audio_boundary(audio_root):
    import io
    from types import SimpleNamespace
    from unittest.mock import patch
    import av
    import numpy as np
    import soundfile
    import sitecustomize
    pyav_release = verify_pyav_release(av, json.loads((audio_root / ".videoq-audio.json").read_text()))
    torchcodec_mask = verify_torchcodec_mask()
    stages = {"beforeVllmImport": ffmpeg_mapping_snapshot()}
    import vllm
    stages["afterVllmImport"] = ffmpeg_mapping_snapshot()

    if getattr(av.open, "__videoq_audio_guard__", None) != "local-audio-only-v2":
        raise ValueError("Refusing native probes without the installed local-input guard")
    guard = audio_root / "sitecustomize.py"
    if (Path(sitecustomize.__file__).resolve() != guard or
            hashlib.sha256(guard.read_bytes()).hexdigest() !=
            "ea09f7753f1ad771f9d7acc6b1a33289e20b6f59e83ac367e03513ffb3a2bb5a"):
        raise ValueError("Unreviewed installed audio adapter")
    package_root = Path(vllm.__file__).resolve().parent.parent
    sources = verify_reviewed_files(package_root, REVIEWED_VLLM_SOURCES)
    members = verify_reviewed_files(audio_root, REVIEWED_PYAV_MEMBERS)
    import vllm.multimodal.audio as audio_utils
    stages["afterMultimodalAudioImport"] = ffmpeg_mapping_snapshot()
    import vllm.multimodal.media.audio as loader
    stages["afterMediaAudioImport"] = ffmpeg_mapping_snapshot()
    if (loader.AudioDecoder is not None
            or not isinstance(loader._torchcodec_import_exc, ModuleNotFoundError)):
        raise ValueError("Actual serving loader did not reject masked TorchCodec decoder")
    from vllm.entrypoints.speech_to_text.base.serving import SpeechToTextBaseServing
    boundary = AudioBoundary(av)
    # No engine/model/weights. Execute the actual installed unbound serving
    # method, with its real decoder and duration implementation.
    server = SimpleNamespace(
        asr_config=SimpleNamespace(sample_rate=16000, allow_audio_chunking=False),
        max_audio_decode_duration_s=1, max_audio_decode_bytes=1024 * 1024,
    )
    cases = []
    with patch.object(loader, "av", boundary), patch.object(audio_utils, "av", boundary):
        # Cover explicit PyAV fallback and the actual auto-selected serving path.
        for fmt in ("WAV", "FLAC"):
            for rate, channels in ((16000, 1), (48000, 2)):
                buf = io.BytesIO()
                time = np.arange(rate // 10, dtype=np.float32) / rate
                tones = [0.2 * np.sin(2 * np.pi * (440 + 220 * channel) * time)
                         for channel in range(channels)]
                soundfile.write(buf, np.stack(tones, axis=1), rate, format=fmt, subtype="PCM_16")
                raw = buf.getvalue()
                waveform, decoded_rate = loader.load_audio_pyav(io.BytesIO(raw), sr=16000)
                emitted, complete = reference_pyav_decode(av, raw)
                fallback = verify_pyav_prefix(waveform, decoded_rate, emitted, complete)
                stages[f"beforeAutoServing-{fmt}-{rate}-{channels}"] = ffmpeg_mapping_snapshot()
                chunks, duration = SpeechToTextBaseServing._decode_and_chunk_speech(server, raw)
                stages[f"afterAutoServing-{fmt}-{rate}-{channels}"] = ffmpeg_mapping_snapshot()
                normalized, native_rate = soundfile.read(io.BytesIO(raw), dtype="float32", always_2d=True)
                normalized = np.mean(normalized, axis=1)
                normalized = audio_utils.resample_audio_pyav(normalized, orig_sr=native_rate, target_sr=16000)
                try:
                    verify_auto_serving_waveform(chunks, duration, normalized)
                except ValueError as error:
                    raise ValueError(f"{error}: format={fmt}, inputRate={rate}, channels={channels}, "
                                     f"duration={duration}, chunkShapes={[chunk.shape for chunk in chunks]}; "
                                     f"fallbackReference={json.dumps(fallback, sort_keys=True)}; "
                                     f"diagnosticImportMaps={json.dumps(stages, sort_keys=True)}") from error
                cases.append({"format": fmt, "rate": rate, "channels": channels,
                              "fallbackReference": fallback})
        for backend in ("azmq", "dynaudnorm", "rtmp"):
            try:
                loader.AudioMediaIO(audio_backend=backend)
            except ValueError:
                pass
            else:
                raise ValueError("Unrecognized media backend accepted")
        # Inputs/options cannot provide a native graph expression on this API.
        media = loader.AudioMediaIO(audio_backend="pyav", filter="dynaudnorm",
                                   options={"filter": "azmq"}, mode="w")
        media.load_bytes(raw)
        for malicious in (b"", b"<CompositionPlaylist><MarkerList/></CompositionPlaylist>",
                          b"rtmp://127.0.0.1/rejected", rb"azmq=bind_address=tcp\://*:5555"):
            try:
                SpeechToTextBaseServing._decode_and_chunk_speech(server, malicious)
            except (ValueError, av.error.FFmpegError):
                pass
            else:
                raise ValueError("Malformed/non-audio serving input accepted")
    if not any(c["operation"] == "AudioResampler" for c in boundary.calls):
        raise ValueError("Native resampling was not exercised")
    # Independently exercise production guard denials, never contact a network.
    rejected = []
    for label, file, kwargs in (
        ("output", io.BytesIO(), {"mode": "w"}),
        ("rtmp", "rtmp://127.0.0.1/rejected", {}),
        ("http", "http://127.0.0.1/rejected", {}),
        ("imf", io.BytesIO(b"not-imf"), {"format": "imf"}),
        ("customIO", io.BytesIO(), {"io_open": lambda *a: None}),
    ):
        try:
            av.open(file, **kwargs)
        except ValueError:
            rejected.append(label)
        else:
            raise ValueError(f"Forbidden native boundary accepted: {label}")
    try:
        libraries = loaded_ffmpeg_libraries(audio_root)
    except ValueError as error:
        raise ValueError(f"{error}; completedAudioCases={json.dumps(cases, sort_keys=True)}; "
                         f"diagnosticImportMaps={json.dumps(stages, sort_keys=True)}") from error
    return {
        "loadedFfmpegLibraries": libraries,
        "diagnosticImportMaps": stages,
        "torchcodecMask": torchcodec_mask,
        "pyavRelease": pyav_release,
        "guardSha256": hashlib.sha256(guard.read_bytes()).hexdigest(),
        "vllmSources": sources, "pyavWheelMembers": members,
        "validCases": cases, "calls": boundary.calls, "guardDenials": rejected,
        "scope": "Actual installed speech preprocessing and explicit PyAV decode; no model execution",
        "nativeFilterTraceComplete": False,
        "remainingGap": "Cython AudioResampler privately cimports Graph; Python facade does not trace internal filter nodes. Exact wheel members are pinned, but complete native filter/command reachability requires instrumented/rebuilt FFmpeg or equivalent native tracing. Multimodal model-specific loaders and alternative torchcodec backend require separate coverage.",
    }


def inspect_patched_dns(audio_root):
    import dns
    import dns.exception
    import dns.rdata
    path = Path(dns.__file__).resolve()
    if importlib.metadata.version("dnspython") != "2.9.2" or path != audio_root / "dns/__init__.py":
        raise ValueError("The pinned patched DNS package must resolve from the read-only runtime volume")
    # Bounded upstream reproducer; do not request a DoS-sized allocation.
    try:
        dns.rdata.from_text("IN", "WKS", "10.0.0.1 udp 65536")
    except dns.exception.SyntaxError:
        return {"version": "2.9.2", "modulePath": str(path), "oversizedWksRejected": True}
    raise ValueError("Patched DNS parser did not reject an out-of-range service")


def inspect_runtime():
    checks = {}

    def check(name, operation):
        try:
            # vLLM initialization may log to stdout; keep the artifact valid JSON.
            with contextlib.redirect_stdout(sys.stderr):
                details = operation()
            checks[name] = {"status": "passed", "details": details}
        except Exception as error:
            checks[name] = {"status": "failed", "errorType": type(error).__name__, "error": str(error)}

    def version():
        value = importlib.metadata.version("vllm")
        if value != "0.33.0":
            raise ValueError(f"Expected pinned vLLM 0.33.0, found {value}")
        return value

    check("version", version)
    audio_root = Path("/opt/videoq-audio").resolve()
    def audio_lock():
        receipt = json.loads((audio_root / ".videoq-audio.json").read_text())
        for name, expected in receipt["manifest"]["basePackages"].items():
            actual = importlib.metadata.version(name)
            if actual != expected:
                raise ValueError(f"Base dependency changed: {name} {actual}, expected {expected}")
        for package in receipt["manifest"]["packages"]:
            if importlib.metadata.version(package["name"]) != package["version"]:
                raise ValueError(f"Audio dependency changed: {package['name']}")
        return receipt["lockSha256"]

    check("audioLock", audio_lock)
    check("security.dnspython", lambda: inspect_patched_dns(audio_root))
    for module in ("av", "soxr", "soundfile", "scipy"):
        def audio_import(module=module):
            loaded = importlib.import_module(module)
            path = Path(loaded.__file__).resolve()
            if not path.is_relative_to(audio_root):
                raise ValueError(f"{module} was imported outside the reviewed audio volume")
            return str(path)
        check(f"audio.{module}", audio_import)

    def decode_audio():
        from io import BytesIO
        import av
        import numpy as np
        import scipy.signal
        import soundfile
        import soxr
        samples = np.zeros(1600, dtype=np.float32)
        stream = BytesIO()
        soundfile.write(stream, samples, 16000, format="WAV")
        stream.seek(0)
        decoded, rate = soundfile.read(stream)
        if rate != 16000 or len(decoded) != len(samples):
            raise ValueError("SoundFile WAV round trip failed")
        stream.seek(0)
        with av.open(stream) as container:
            if sum(frame.samples for frame in container.decode(audio=0)) != len(samples):
                raise ValueError("PyAV could not decode WAV samples")
        if len(soxr.resample(samples, 16000, 8000)) != 800 or len(scipy.signal.resample_poly(samples, 1, 2)) != 800:
            raise ValueError("Audio resampling failed")
        return {"decodedSamples": len(decoded), "rate": rate}

    check("audioDecodeAndResample", decode_audio)
    check("security.servingAudioBoundary", lambda: inspect_serving_audio_boundary(audio_root))

    def audio_security():
        import av
        import sitecustomize
        guard = audio_root / 'sitecustomize.py'
        receipt = json.loads((audio_root / '.videoq-audio.json').read_text())
        if Path(sitecustomize.__file__).resolve() != guard or hashlib.sha256(guard.read_bytes()).hexdigest() != receipt['manifest']['runtimeGuardSha256']:
            raise ValueError('Audio startup guard identity changed')
        if getattr(av.open, '__videoq_audio_guard__', None) != 'local-audio-only-v2':
            raise ValueError('PyAV must enforce the reviewed local-audio guard')
        try:
            av.open('rtsp://127.0.0.1/rejected')
        except ValueError as error:
            if 'network URLs' not in str(error):
                raise
        else:
            raise ValueError('RTSP input was not rejected before network I/O')
        # A-law is a valid WAV codec, but is outside the supported input contract.
        import io
        import struct
        data = b'\xd5' * 160
        wav = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH',16,6,1,16000,16000,1,8) + b'data' + struct.pack('<I',len(data)) + data
        try:
            with av.open(io.BytesIO(wav), format='wav') as container:
                list(container.decode(audio=0))
        except (ValueError, av.error.FFmpegError):
            pass
        else:
            raise ValueError('Unsupported WAV codec was not rejected')
        return {'guardSha256': receipt['manifest']['runtimeGuardSha256'], 'rtspRejected': True,
                'unsupportedWavCodecRejected': True, 'allowedCodecs': ['flac','mp3','mp3float','pcm_s16le']}

    check('security.audio', audio_security)

    check('security.maskedNative', verify_native_masks)
    check('security.maskedNativeDenial', lambda: verify_masked_native_denial(audio_root))

    def registry():
        from vllm.model_executor.models import ModelRegistry
        architectures = ("GptOssForCausalLM", "Gemma4ForConditionalGeneration", "EmbeddingGemma2Model", "WhisperForConditionalGeneration")
        for architecture in architectures:
            if architecture not in ModelRegistry.get_supported_archs():
                raise ValueError(f"Missing architecture: {architecture}")
        return list(architectures)

    check("modelRegistry", registry)

    def embeddings():
        from vllm.entrypoints.pooling.embed.protocol import EmbeddingCompletionRequest
        request = EmbeddingCompletionRequest(model="probe", input="task: search result | query: probe", dimensions=768)
        if request.to_pooling_params().dimensions != 768:
            raise ValueError("Embedding API did not preserve 768 dimensions")
        return {"dimensions": 768}

    check("embeddingProtocol", embeddings)
    return {"status": "passed" if all(c["status"] == "passed" for c in checks.values()) else "failed", "checks": checks}


if __name__ == "__main__":
    result = inspect_runtime()
    print(json.dumps(result))
    sys.exit(0 if result["status"] == "passed" else 1)
