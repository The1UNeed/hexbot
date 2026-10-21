`67e895d-bot-journal.json` is the journal produced by the actual
`67e895d7b02e91aeeaa1f1a5391dc4448b362de1` library's
`catalog::prepare_bot_delete`, before its catalog commit. Only the generated chat
UUID is replaced by `@chat@`. The fixture includes native chat and room delegates,
a hidden native session, and the duplicate chat and room targets that build
wrote. It has no retirement attempt ID.

The producer uses the cross-build `old_state.rs` probe, with `hidden-run` added
before preparation. It links the parent's existing exact-67 control library;
that library was reused, not rebuilt for this implementation. The integration
tests insert this captured journal directly and reproduce that build's persisted
marker format, only `native_deleted`, without calling the current preparation or
retirement writers. Separate cross-build validation runs the unchanged original
probe through actual 67 preparation and retirement, exact-e3 startup and repaired
startup.
