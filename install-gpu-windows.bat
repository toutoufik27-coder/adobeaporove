@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo Quality Guard - local AI on your NVIDIA GPU (text reading + face detection)
echo Downloads PyTorch with CUDA (about 3 GB). Run install-windows.bat first.
echo.
where nvidia-smi >nul 2>nul && nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
echo.
rem Newest CUDA build first; older ones for older drivers.
for %%C in (cu128 cu130 cu126) do (
  echo Trying PyTorch %%C ...
  python -m pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/%%C && goto torch_ok
)
echo.
echo Could not install the CUDA build of PyTorch. Update your NVIDIA driver and try again.
pause
exit /b 1
:torch_ok
python -m pip install ".[gpu]"
if errorlevel 1 (
  echo Installing the local AI packages failed.
  pause
  exit /b 1
)
echo.
python -c "import torch; ok = torch.cuda.is_available(); print('GPU ready:', torch.cuda.get_device_name(0) if ok else 'NO - will run on the CPU')"
echo The first scan downloads the text-reading model once (about 100 MB).
pause
