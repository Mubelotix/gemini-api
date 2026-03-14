This codebase is complex and always requires Claude models.
When files get a little big, you may attempt to split them.

## Docker script

Located in file ./ff.sh
Keep --rm on the docker and never enable restart.

## Backend

Located in folder ./backend
Use anyhow for error handling.
Check using `cargo clippy` after edits.
When changing the API or the logic behind it, make sure to offer a curl command to test the API manually once you are done implementing.

We don't support the whole APIs we emulate.
However, we should not return errors over usage of fields we don't implement.
Fields with limited impact, that do not break the response, should be ignored.
We only return errors when we know the client won't be satisfied with what we can return.

When fixing an issue, you may add a unit test if relevant.
Unit tests must not however require internet access and must not need to interact with the extension.

## Extension

All parsing should be done in a way that minimizes the risk of things breakings when the website is updated (i.e. not relying on class names if possible).

