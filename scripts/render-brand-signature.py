"""Render Kinetra's original synthetic sonic identity. No external samples.
Optional authoring tool: Python + NumPy + SciPy + ffmpeg. Not a runtime dependency.
"""
from pathlib import Path
import subprocess, tempfile
import numpy as np
from scipy import signal
from scipy.io import wavfile
RATE = 48000
DURATION = 7.0
rng = np.random.default_rng(19092026)
t = np.arange(int(RATE * DURATION)) / RATE
mix = np.zeros((len(t), 2), dtype=np.float64)
def add(mono, pan=0):
    mix[:, 0] += mono * np.sqrt((1-pan)/2)
    mix[:, 1] += mono * np.sqrt((1+pan)/2)
def bell(start, hz, gain, decay, pan=0):
    u = np.maximum(0, t-start)
    envelope = (1-np.exp(-u/0.008)) * np.exp(-u/decay) * (t>=start)
    tone = sum(a*np.sin(2*np.pi*hz*r*u) * np.exp(-u/d) for r,a,d in [(1,1,5),(2.001,.28,1.1),(3.006,.09,.45),(4.02,.03,.2)])
    add(tone*envelope*gain,pan)
    for delay,level,side in [(.091,.15,-pan),(.157,.09,pan),(.253,.035,-pan)]:
        shift = int(delay*RATE)
        add(np.r_[np.zeros(shift),(tone*envelope*gain)[:-shift]]*level,side)
def air(start,end,gain,pan,up=True):
    u=np.clip((t-start)/(end-start),0,1)
    noise=signal.sosfilt(signal.butter(2,[800,5800],fs=RATE,btype='bandpass',output='sos'),rng.standard_normal(len(t)))
    env=(u**2 if up else (1-u)**2)*np.sin(np.pi*u)**.6
    add(noise*env*gain*((t>=start)&(t<=end)),pan)
air(.12,1.09,.13,-.45)
air(.35,1.12,.08,.45)
u=np.maximum(0,t-1.065)
phase=2*np.pi*(55*u+(128-55)*.047*(1-np.exp(-u/.047)))
impact=np.sin(phase)*(1-np.exp(-u/.0015))*np.exp(-u/.23)*(t>=1.065)
add(.6*impact)
bell(1.075,164.8138,.16,.66,-.15)
bell(1.78,246.9417,.085,.72,.22)
bell(2.66,369.9944,.17,1.05,-.1)
bell(2.672,739.9888,.035,.56,.35)
air(2.38,2.76,.065,.25)
# A warm harmonic body resolves under the held mark, with a slow stereo bloom.
u=np.maximum(0,t-2.67)
env=(1-np.exp(-u/.15))*np.exp(-u/1.1)*(t>=2.67)
add(env*.055*(np.sin(2*np.pi*123.4708*u)+.3*np.sin(2*np.pi*246.9417*u)),-.3)
add(env*.052*(np.sin(2*np.pi*123.58*u)+.3*np.sin(2*np.pi*247.1*u)),.3)
air(5.7,6.18,.075,-.3)
air(6.13,6.65,.08,.3,False)
bell(6.14,493.8833,.025,.12,.2)
fade=np.clip((DURATION-t)/.45,0,1)
mix=np.tanh(mix*1.2)*fade[:,None]
with tempfile.TemporaryDirectory() as folder:
    source=Path(folder)/'signature.wav'
    wavfile.write(source,RATE,(mix*32767).astype(np.int16))
    target=Path(__file__).resolve().parents[1]/'apps/frontend/src/assets/brand/kinetra-signature.mp3'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-af','loudnorm=I=-19:TP=-2:LRA=7','-ar','48000','-c:a','libmp3lame','-b:a','128k','-map_metadata','-1',str(target)],check=True)
    print(f'Original stereo signature: {target.name}, {target.stat().st_size} bytes')
