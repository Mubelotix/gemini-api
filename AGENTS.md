This codebase is complex and always requires Claude models.

## Docker script

Located in file ./ff.sh
Keep --rm on the docker and never enable restart.

## Backend

Located in folder ./backend
Use anyhow for error handling.
Check using `cargo clippy` after edits.
When changing the API or the logic behind it, make sure to offer a curl command to test the API manually once you are done implementing.
