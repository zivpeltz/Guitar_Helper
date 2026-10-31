interface Credit {
  name: string;
  by: string;
  license: string;
  url: string;
  use: string;
}

// Licenses checked against the installed packages' metadata (Python) and package.json (npm).
const SOFTWARE: Credit[] = [
  { name: 'alphaTab', by: 'Daniel Kuschny and contributors', license: 'MPL-2.0', url: 'https://alphatab.net', use: 'Renders notation and tablature, cursor, MIDI synth' },
  { name: 'Bravura', by: 'Steinberg Media Technologies GmbH', license: 'SIL Open Font License 1.1', url: 'https://github.com/steinbergmedia/bravura', use: 'Music notation font' },
  { name: 'SONiVOX EAS soundfont', by: 'Sonic Network Inc.', license: 'Apache-2.0', url: 'https://android.googlesource.com/platform/external/sonivox/', use: 'Instrument sounds for the tab synth' },
  { name: 'Demucs (htdemucs_6s)', by: 'Meta Platforms, Inc. (Alexandre Défossez et al.)', license: 'MIT', url: 'https://github.com/facebookresearch/demucs', use: 'AI separation of the guitar from the recording' },
  { name: 'PyTorch', by: 'The PyTorch Foundation and contributors', license: 'BSD-3-Clause (with bundled components under their own licenses)', url: 'https://pytorch.org', use: 'Runs the separation model' },
  { name: 'yt-dlp', by: 'yt-dlp contributors', license: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp', use: 'Finds and fetches recordings from YouTube' },
  { name: 'yt-dlp-ejs', by: 'yt-dlp contributors', license: 'Unlicense, MIT and ISC', url: 'https://github.com/yt-dlp/ejs', use: 'YouTube challenge solver for yt-dlp' },
  { name: 'Deno', by: 'the Deno authors', license: 'MIT', url: 'https://deno.com', use: 'JavaScript runtime used by yt-dlp' },
  { name: 'FFmpeg', by: 'the FFmpeg developers', license: 'LGPL-2.1+ / GPL (depending on the build)', url: 'https://ffmpeg.org', use: 'Audio decoding and encoding' },
  { name: 'imageio-ffmpeg', by: 'the imageio contributors', license: 'BSD-2-Clause', url: 'https://github.com/imageio/imageio-ffmpeg', use: 'Ships an FFmpeg binary' },
  { name: 'librosa', by: 'the librosa development team', license: 'ISC', url: 'https://librosa.org', use: 'Audio analysis for auto-sync and part splitting' },
  { name: 'NumPy / SciPy / scikit-learn / Numba', by: 'their respective developers', license: 'BSD-3-Clause (and compatible)', url: 'https://numpy.org', use: 'Numerical computing' },
  { name: 'pretty_midi / mido', by: 'Colin Raffel / Ole Martin Bjørndalen et al.', license: 'MIT', url: 'https://github.com/craffel/pretty-midi', use: 'Reading the tab as MIDI' },
  { name: 'soundfile', by: 'Bastian Bechtold et al.', license: 'BSD-3-Clause', url: 'https://github.com/bastibe/python-soundfile', use: 'Writing audio files' },
  { name: 'lameenc', by: 'Chris Smith', license: 'LGPL-3.0-or-later', url: 'https://github.com/chrisstaite/lameenc', use: 'MP3 encoder (Demucs dependency)' },
  { name: 'FastAPI / Starlette / Pydantic', by: 'Sebastián Ramírez / Encode / Pydantic Services', license: 'MIT / BSD-3-Clause / MIT', url: 'https://fastapi.tiangolo.com', use: 'Local web server' },
  { name: 'Uvicorn / HTTPX', by: 'Encode OSS', license: 'BSD-3-Clause', url: 'https://www.uvicorn.org', use: 'Web server and HTTP client' },
  { name: 'python-multipart', by: 'Andrew Dunham, Marcelo Trylesinski', license: 'Apache-2.0', url: 'https://github.com/Kludex/python-multipart', use: 'File uploads' },
  { name: 'Hugging Face Hub', by: 'Hugging Face', license: 'Apache-2.0', url: 'https://github.com/huggingface/huggingface_hub', use: 'Downloads the separation model' },
  { name: 'React', by: 'Meta Platforms, Inc.', license: 'MIT', url: 'https://react.dev', use: 'User interface' },
  { name: 'Vite', by: 'VoidZero Inc. and contributors', license: 'MIT', url: 'https://vite.dev', use: 'Builds the user interface' },
];

const METHODS = [
  'Score-informed source separation with NMF, after S. Ewert & M. Müller, “Using score-informed constraints for NMF-based source separation”, ICASSP 2012. Used for the experimental single-part splits.',
  'Audio-to-score alignment with chroma features and dynamic time warping, used for auto-sync.',
];

export default function Credits({ onBack }: { onBack: () => void }) {
  return (
    <div className="home credits">
      <button className="ghost" onClick={onBack}>
        ← Back
      </button>
      <h1>Credits &amp; legal</h1>

      <section>
        <h2>Content</h2>
        <ul className="credit-notes">
          <li>
            <b>Tabs</b> come from <a href="https://www.songsterr.com" target="_blank" rel="noreferrer">Songsterr</a> and remain
            the property of Songsterr and the transcribers who made them. Guitar Helper reads them through Songsterr's public
            website endpoints. It isn't an official Songsterr app.
          </li>
          <li>
            <b>Recordings and backing tracks</b> come from <a href="https://www.youtube.com" target="_blank" rel="noreferrer">YouTube</a> and
            belong to their artists, labels and uploaders. Bar timings for synced videos come from Songsterr.
          </li>
          <li>
            <b>Songs</b> (compositions and lyrics) are the property of their writers and publishers.
          </li>
          <li>
            <b>Your own files</b> that you open (Guitar Pro, MusicXML) stay on this computer.
          </li>
        </ul>
      </section>

      <section>
        <h2>Legal notice</h2>
        <p className="muted">
          Guitar Helper is a free, non-commercial tool for personal music practice. It isn't affiliated with, endorsed by or
          sponsored by Songsterr, YouTube, Google, the artists, or any rights holder. All trademarks belong to their owners.
          The app doesn't ship with any tabs or recordings: everything is fetched on request and cached only on this computer.
        </p>
        <p className="muted">
          You're responsible for using it in line with the terms of service of Songsterr and YouTube and the copyright law where
          you live. Don't redistribute downloaded or separated audio or tabs. To remove cached content, delete a song from
          "Recently opened" or delete the <code>data</code> folder.
        </p>
        <p className="muted">
          The software is provided "as is", without warranty of any kind.
        </p>
      </section>

      <section>
        <h2>Open-source software</h2>
        <p className="muted">Guitar Helper is built on these projects. Thank you to their authors.</p>
        <table className="credit-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>License</th>
              <th>Used for</th>
            </tr>
          </thead>
          <tbody>
            {SOFTWARE.map((c) => (
              <tr key={c.name}>
                <td>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.name}
                  </a>
                  <div className="muted by">{c.by}</div>
                </td>
                <td>{c.license}</td>
                <td className="muted">{c.use}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small-print">
          Full license texts ship with each package: <code>frontend/node_modules/*/LICENSE</code>, the
          Python packages' metadata in <code>backend/.venv</code>, <code>frontend/public/font/Bravura-OFL.txt</code> and{' '}
          <code>frontend/public/soundfont/LICENSE</code>. Other packages these depend on are listed in those folders too.
        </p>
      </section>

      <section>
        <h2>Methods</h2>
        <ul className="credit-notes">
          {METHODS.map((m) => (
            <li key={m} className="muted">
              {m}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
