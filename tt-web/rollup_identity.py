#!/usr/bin/env python3
import argparse
import shlex
import sys

import aggregators


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="tt-web rollup",
        description=(
            "Inspect persistent project-identity blockers and explicitly pin a resolved source. "
            "A blocked source keeps its existing rollup rows, but new usage is not written until recovery."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "blockers",
        help="list persistent active blockers and available recovery guidance",
    )
    recover = subparsers.add_parser(
        "recover",
        help="pin a source after its current path or remote uniquely matches an existing identity",
    )
    recover.add_argument("--path", required=True, help="blocked source path")
    recover.add_argument(
        "--pin-existing",
        required=True,
        help="existing identity that must be directly and uniquely derivable from this source",
    )
    args = parser.parse_args(argv)

    try:
        if args.command == "blockers":
            return _print_blockers()
        recovered = aggregators.pin_project_identity(args.path, args.pin_existing)
        print(
            "RECOVERED: pinned {source_path} to directly matched identity {project}; status={status}".format(
                source_path=recovered["source_path"],
                project=args.pin_existing,
                status=recovered["status"],
            )
        )
        return 0
    except aggregators.ProjectIdentityRecoveryError as exc:
        print("RECOVERY REFUSED: %s" % exc, file=sys.stderr)
        return 2


def _print_blockers():
    blockers = aggregators.list_project_identity_blockers(status="active")
    if not blockers:
        print("OK: no active project identity blockers.")
        return 0

    print(
        "ATTENTION: %d ACTIVE project identity blocker(s). Existing rollup rows are preserved, "
        "but new usage from these paths is not being written." % len(blockers)
    )
    for blocker in blockers:
        candidate = blocker["resolved_candidate"] or "unavailable"
        path_arg = shlex.quote(blocker["source_path"])
        print("")
        print("source_path: %s" % blocker["source_path"])
        print("reason: %s" % blocker["reason"])
        print("resolved_candidate: %s" % candidate)
        print("pin_candidate: %s" % (blocker["pin_candidate"] or "unavailable"))
        print("first_seen: %s" % blocker["first_seen"])
        print("last_seen: %s" % blocker["last_seen"])
        print("status: %s" % blocker["status"])
        print("Recovery never rewrites historical rollup rows.")
        if blocker["pin_candidate"]:
            print("Available recovery command:")
            pin_target = shlex.quote(blocker["pin_candidate"])
            print("  tt-web rollup recover --path %s --pin-existing %s" % (path_arg, pin_target))
        else:
            print("Safe pinning is not possible for this blocker. It will stay active.")
            print("Migrating historical project keys is not supported by this tooling.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
