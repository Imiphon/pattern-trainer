import { KEYBOARD_LAYOUT } from "./constants.js";

export function createKeyboard(container, onNoteTrigger) {
  const keyElements = new Map();
  KEYBOARD_LAYOUT.forEach(({ white, label, black }) => {
    const wrapper = document.createElement("div");
    wrapper.className = "key-wrapper";

    const whiteKey = createKeyElement(white, label, "white", onNoteTrigger);
    wrapper.append(whiteKey);
    keyElements.set(white, whiteKey);

    if (black) {
      const blackKey = createKeyElement(black.note, black.label ?? black.note, "black", onNoteTrigger);
      wrapper.append(blackKey);
      keyElements.set(black.note, blackKey);
    }

    container.append(wrapper);
  });
  return keyElements;
}

function createKeyElement(note, label, variant, onNoteTrigger) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `key ${variant}`;
  btn.dataset.note = note;
  btn.setAttribute("aria-label", `Note ${label}`);

  const span = document.createElement("span");
  span.className = "key-label";
  span.textContent = label;
  btn.append(span);

  const pressHandler = (event) => {
    event.preventDefault();
    onNoteTrigger(note);
  };

  btn.addEventListener("pointerdown", pressHandler);
  btn.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      onNoteTrigger(note);
    }
  });

  return btn;
}
