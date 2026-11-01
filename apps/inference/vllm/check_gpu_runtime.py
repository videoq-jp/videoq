"""Site acceptance: fail unless the requested GPU stack executes FP16 matmul."""
import argparse
import json


def check(accelerator):
    import torch

    hip = getattr(torch.version, 'hip', None)
    cuda = getattr(torch.version, 'cuda', None)
    if accelerator == 'amd' and not hip:
        raise RuntimeError('AMD acceptance requires ROCm PyTorch; a CUDA/CPU image was selected')
    if accelerator == 'nvidia' and (hip or not cuda):
        raise RuntimeError('NVIDIA acceptance requires CUDA PyTorch; a ROCm/CPU image was selected')
    if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
        raise RuntimeError('No usable allocated GPU; check the driver, device plugin and device permissions')
    # PyTorch exposes HIP devices through its cuda API as well.
    left = torch.ones((32, 32), dtype=torch.float16, device='cuda')
    result = left @ left
    if not bool((result == 32).all().item()):
        raise RuntimeError('GPU FP16 matrix multiplication produced an unexpected result')
    print(json.dumps({'accelerator': accelerator, 'torch': torch.__version__,
                      'hip': hip, 'cuda': cuda, 'device': torch.cuda.get_device_name(0),
                      'visible_devices': torch.cuda.device_count(), 'fp16_matmul': 'passed'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('accelerator', choices=['amd', 'nvidia'])
    check(parser.parse_args().accelerator)
