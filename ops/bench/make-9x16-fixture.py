"""Derive a deterministic 1080x1920 / 20s fixture from the 540x960 semantic-composition project.

Nothing is generated and no provider is called: the canvas grows, the timeline lengthens and the
authored message list gets longer. That keeps the render local-only and repeatable, which is what a
resource baseline needs — a number produced by a paid model call would not be comparable twice.
"""
import io
import sys

path = sys.argv[1]
text = io.open(path, encoding="utf-8").read()

text = text.replace(
    '<spatial:Canvas id="canvas" width="540" height="960"/>',
    '<spatial:Canvas id="canvas" width="1080" height="1920"/>',
)
text = text.replace('end="8s"', 'end="20s"')

messages = [
    ("q1", "Maya", "left", "0.5s", "Are we ready to launch?"),
    ("r1", "Leo", "right", "2s", "The video is ready."),
    ("q2", "Maya", "left", "3.5s", "Great. One tiny change..."),
    ("r2", "Leo", "right", "5.2s", "I left the whole scene editable."),
    ("q3", "Maya", "left", "7s", "Can it hold a full vertical frame?"),
    ("r3", "Leo", "right", "8.8s", "It renders at 1080 by 1920."),
    ("q4", "Maya", "left", "10.5s", "And the timing stays exact?"),
    ("r4", "Leo", "right", "12.2s", "Every message is anchored to the clock."),
    ("q5", "Maya", "left", "14s", "Good. Ship the baseline."),
    ("r5", "Leo", "right", "15.8s", "Measuring it now."),
    ("q6", "Maya", "left", "17.5s", "Numbers beat guesses."),
]
block = "\n".join(
    '    <chat:Message id="{0}" sender="{1}" side="{2}" at="{3}" text="{4}"/>'.format(*m)
    for m in messages
)

start = text.index("    <chat:Message")
close = text.index("</chat:Scene>")
end = text.rindex("/>", start, close) + 2
text = text[:start] + block + text[end:]

io.open(path, "w", encoding="utf-8").write(text)
print("messages:", len(messages))
