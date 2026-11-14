# Synthetic audio format fixtures

These half-second sine tones were generated with FFmpeg. The AAC/ADTS, AAC/M4A, 24-bit PCM WAV, Vorbis/Ogg, Opus/Ogg and Opus/WebM samples verify successful import, content type and decoding. The ALAC/M4A sample verifies a useful unsupported-codec report.

Generate any source with FFmpeg using this template; replace CODEC and EXT using the pairs below:

~~~powershell
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.5 -c:a CODEC -metadata title="Tone EXT" tone.EXT
~~~

| EXT | CODEC |
|---|---|
| aac | aac |
| m4a | aac |
| wav | pcm_s24le |
| ogg | libvorbis |
| opus | libopus |
| webm | libopus |
| alac.m4a | alac |
| flac.m4a | flac (add `-strict experimental -f mp4` before the output path) |
