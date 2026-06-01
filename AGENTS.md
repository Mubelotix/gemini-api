This codebase is complex and always requires Claude models.
When files get a little big, you may attempt to split them.

## Docker script

Located in file ./ff.sh
Keep --rm on the docker and never enable restart.

## Backend

Located in folder ./backend
Implemented in Python using BentoML and FastAPI.
When changing the API or the logic behind it, make sure to offer a curl command to test the API manually once you are done implementing.

### Type checking
All Python files under `backend/` must have full type annotations. Run static type checking using:
`.venv/bin/mypy --check-untyped-defs backend`
Ensure that the mypy run reports no errors, as this check is enforced in CI.


## Extension

All parsing should be done in a way that minimizes the risk of things breakings when the website is updated (i.e. not relying on class names if possible).

