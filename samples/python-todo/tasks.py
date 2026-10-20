"""A tiny task list used by the Punani powerd sample project."""


class TaskList:
    def __init__(self):
        self._tasks = []

    def add(self, title):
        self._tasks.append({"title": title, "done": False})
        return len(self._tasks)

    def complete(self, index):
        if index < 0 or index >= len(self._tasks):
            raise IndexError(f"no task at index {index}")
        self._tasks[index]["done"] = True
        return self._tasks[index]

    def pending(self):
        return [task for task in self._tasks if not task["done"]]

    def __len__(self):
        return len(self._tasks)
