import assert from "node:assert/strict";
import { test } from "node:test";
import { createWindowNavigation } from "./navigation.ts";

function windowPort(visible = false) {
  return { visible, focused: false,
    show() { this.visible = true; }, showInactive() { this.visible = true; }, hide() { this.visible = false; },
    focus() { this.focused = true; },
  };
}

test("Dock during recording opens the current full transcript and hides the preview", () => {
  const library = windowPort();
  const glance = windowPort(true);
  let selected = "history";
  const navigation = createWindowNavigation({
    library: () => library, glance: () => glance,
    recordingId: () => "current",
    select: (id) => { selected = id; },
  });
  navigation.openLibrary();
  assert.equal(library.visible, true);
  assert.equal(library.focused, true);
  assert.equal(glance.visible, false);
  assert.equal(selected, "current");
});

test("closing either surface keeps recording alive; idle close can be reopened and quit can close", () => {
  const library = windowPort(true);
  const glance = windowPort();
  let recordingId = "current";
  const navigation = createWindowNavigation({
    library: () => library, glance: () => glance,
    recordingId: () => recordingId, select: () => {},
  });
  assert.equal(navigation.closeLibrary(false), false);
  assert.equal(library.visible, false);
  assert.equal(glance.visible, true);
  navigation.hideGlance();
  assert.equal(glance.visible, false);
  assert.equal(recordingId, "current");
  navigation.openLibrary();
  navigation.showGlance();
  assert.equal(library.visible, false);
  assert.equal(glance.visible, true);
  recordingId = null;
  navigation.openLibrary();
  assert.equal(navigation.closeLibrary(false), false);
  assert.equal(library.visible, false);
  navigation.openLibrary();
  assert.equal(library.visible, true);
  assert.equal(navigation.closeLibrary(true), true);
});


// Showing the glance must preserve the meeting app focus. This window-port model does not prove native macOS behavior.

function recordingWithMeetingFocused() {
  let focusedWindow = "meeting";
  function windowPort(name, visible) {
    return {
      visible,
      show() {
        this.visible = true;
        focusedWindow = name;
      },
      showInactive() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
        if (focusedWindow === name) focusedWindow = null;
      },
      focus() {
        focusedWindow = name;
      },
    };
  }
  const library = windowPort("library", true);
  const glance = windowPort("glance", false);
  const navigation = createWindowNavigation({
    library: () => library,
    glance: () => glance,
    recordingId: () => "current-recording",
    select: () => {},
  });
  return {
    navigation,
    snapshot: () => ({
      focusedWindow,
      libraryVisible: library.visible,
      glanceVisible: glance.visible,
    }),
  };
}

for (const action of ["showGlance", "closeLibrary"]) {
  test(`${action} during recording shows the glance without taking meeting focus`, () => {
    const { navigation, snapshot } = recordingWithMeetingFocused();
    if (action === "closeLibrary") navigation.closeLibrary(false);
    else navigation.showGlance();

    assert.deepEqual(snapshot(), {
      focusedWindow: "meeting",
      libraryVisible: false,
      glanceVisible: true,
    });
  });
}

test("control: opening the library during recording gives the visible library focus", () => {
  const { navigation, snapshot } = recordingWithMeetingFocused();
  navigation.openLibrary();

  assert.deepEqual(snapshot(), {
    focusedWindow: "library",
    libraryVisible: true,
    glanceVisible: false,
  });
});
