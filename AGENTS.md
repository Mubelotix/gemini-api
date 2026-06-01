This codebase is complex and always requires Claude models.
When files get a little big, you may attempt to split them.

## Docker script

Located in file ./ff.sh
Keep --rm on the docker and never enable restart.

## Backend

Located in folder ./backend
Implemented in Python using BentoML and FastAPI.
When changing the API or the logic behind it, make sure to offer a curl command to test the API manually once you are done implementing.


## Extension

All parsing should be done in a way that minimizes the risk of things breakings when the website is updated (i.e. not relying on class names if possible).

