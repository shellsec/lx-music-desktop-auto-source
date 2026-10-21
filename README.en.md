# LX Music Enhanced

A derivative of [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop), under Apache-2.0. Original copyright notices are preserved; see NOTICE for modifications.

Import your own local custom source scripts or enter your own script URL in Settings. A fresh installation has no sources. Multi-source automatic switching is off by default and retries only imported sources in list order. Reorder sources in Settings.

Save your subscription address once; it persists across restarts. After all imported sources fail, automatic switching checks the subscription once per song and retries one additional round only when the catalog or script contents changed. Automatic checks have a 60-second cooldown across songs; manual updates bypass it. The URL is empty by default; the documentation example is `https://example.com/sources.json`. Lists accept an array or a `sources` array of entries with `id`, `name`, and HTTPS `url`. Failed updates preserve existing sources; unchanged contents do not trigger a second round.

This software provides no music sources. Users are responsible for imported content and must comply with local laws and copyright requirements.
