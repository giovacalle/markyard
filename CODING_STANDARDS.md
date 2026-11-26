# Coding standards

Rules reviewers apply to every change.

- **Test-motivated production changes.** A change to a runtime path (render, mount, parse, boot) whose stated reason is test timing or flakiness is a **major** finding unless the reviewer measured its runtime cost against base. The required fix keeps production unchanged and makes the test await the state it needs (`waitFor`, `ensureSyntaxTree` inside the test, fake timers).
