# Synthetic camera clips

The `.y4m` files in this directory are generated, gitignored (about 35 MB
each) and fed to Chromium's fake camera by the end-to-end tests. Regenerate
them from the repo root:

```sh
python3 scripts/make-test-video.py --out tests/fixtures/video/flow-ne.y4m --angle 45  --speed 1.5 --jitter 1.2 --seconds 5 --fps 15
python3 scripts/make-test-video.py --out tests/fixtures/video/flow-s.y4m  --angle 180 --speed 1.5 --jitter 1.2 --seconds 5 --fps 15
python3 scripts/make-test-video.py --out tests/fixtures/video/still.y4m   --still --seconds 5 --fps 15
python3 scripts/make-test-video.py --out tests/fixtures/video/blank.y4m   --blank --seconds 5 --fps 15
```

| file          | content                                                | expected motion / angle |
|---------------|--------------------------------------------------------|-------------------------|
| `flow-ne.y4m` | water moving up-right (45°) at 1.5 px/frame*, 1.2 px* jitter | `flowing`, 45° on screen |
| `flow-s.y4m`  | water moving down (180°) at 1.5 px/frame*, 1.2 px* jitter    | `flowing`, 180° on screen |
| `still.y4m`   | textured water, no motion                              | `still`                 |
| `blank.y4m`   | flat gray                                              | `no_texture`            |

\* in pixels at the app's analysis width (160 px), i.e. after the app has
downscaled the 640x480 camera frame; on the file itself that is 6 px/frame
and 4.8 px. The clips loop seamlessly (see the script's docstring).

`tests/flow.test.mjs` also runs the optical flow over these files when they
exist (downscaled with a box filter like the app) and skips those tests
otherwise. Screen angle 0 is up the screen, clockwise positive; the compass
bearing is `screenUpHeading + angle`.
