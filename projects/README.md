# Projects directory

The default **`drone-2026`** package is not copied into this repo as ordinary files. It is included as a [**Git submodule**](https://git-scm.com/book/en/v2/Git-Tools-Submodules): a nested repository pinned to a specific commit of [UAVs-at-Berkeley/drone-2026](https://github.com/UAVs-at-Berkeley/drone-2026).

After cloning Elytra Bridge:

```bash
git submodule update --init --recursive
```

Or clone with submodules in one step:

```bash
git clone --recurse-submodules <elytra-bridge-repo-url>
```

To move the submodule checkout to the latest commit on its tracked branch (`main` in `.gitmodules`):

```bash
git submodule update --remote projects/drone-2026
```

Then commit the updated submodule pointer in Elytra Bridge if you want everyone else on that revision.

You can also open any other compliant project folder via **File → Open Project** in the UI without using `projects/drone-2026`.
