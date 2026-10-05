import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import parseRLE from "commodetto/parseRLE";

function getFont(name, size) {
  const font = parseBMF(new Resource(`${name}-${size}.fnt`));
  font.bitmap = parseRLE(new Resource(`${name}-${size}-alpha.bm4`));
  return font;
}

export function createDisplay() {
  const render = new Poco(screen);
  const black = render.makeColor(0, 0, 0);
  const white = render.makeColor(255, 255, 255);
  const bigFont = getFont("OpenSans-Bold", 64);
  const mediumFont = getFont("OpenSans-Bold", 40);
  const smallFont = getFont("OpenSans-Regular", 16);
  const margin = 8;

  function centered(text, font, color, y) {
    const w = render.getTextWidth(text, font);
    render.drawText(text, font, color, (render.width - w) >> 1, y);
  }

  // Split the status line at a space if it is too wide for one line (at most two lines).
  function statusLines(text) {
    const max = render.width - 2 * margin;
    if (render.getTextWidth(text, smallFont) <= max) return [text];
    for (let i = text.lastIndexOf(" "); i > 0; i = text.lastIndexOf(" ", i - 1)) {
      const first = text.slice(0, i);
      if (render.getTextWidth(first, smallFont) <= max) return [first, text.slice(i + 1)];
    }
    return [text];
  }

  return {
    draw(big, status) {
      let font = bigFont;
      if (render.getTextWidth(big, font) > render.width - 2 * margin) font = mediumFont;
      render.begin(0, 0, render.width, render.height);
      render.fillRectangle(white, 0, 0, render.width, render.height);
      centered(big, font, black, ((render.height - font.height) >> 1) - 12);
      const lines = statusLines(status);
      let y = render.height - margin - lines.length * smallFont.height;
      for (const line of lines) {
        centered(line, smallFont, black, y);
        y += smallFont.height;
      }
      render.end();
    },
  };
}
