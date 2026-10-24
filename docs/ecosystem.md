# Ecosystem

chanx-js is the TypeScript side of the chanx family. They share one protocol, so their
parts work together.

## chanx

[chanx](https://github.com/huynguyengl99/chanx) is the original: the same framework for
Python, on Django Channels and FastAPI, with Pydantic messages, AsyncAPI generation and
testing utilities. Its [documentation](https://chanx.readthedocs.io) covers the Python
side.

- A chanx-js client talks to a chanx server: generate it from the server's AsyncAPI.
- A chanx-js server and a chanx server share one Redis. See
  [Python and Node together](/advanced/python).
- Majors move together: chanx-js 2.x speaks the chanx 2 protocol.

## chanx-kit

[chanx-kit](https://huynguyengl99.github.io/chanx-kit/) is a set of WebSocket components
for chanx, such as notifications, chat with replayed history, a presence roster and an
agent streaming tokens. Each is copied into your project with one command, as code you
own, in the spirit of shadcn/ui. Server kits are Python; UI kits, React first, are
installed the same way, and its FastAPI and React template types the client from the
server's schema.
