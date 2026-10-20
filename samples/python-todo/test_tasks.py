import unittest

from tasks import TaskList


class TaskListTests(unittest.TestCase):
    def test_add_and_complete(self):
        tasks = TaskList()
        tasks.add("write the code")
        tasks.add("write the tests")
        self.assertEqual(len(tasks), 2)
        tasks.complete(0)
        self.assertEqual(len(tasks.pending()), 1)

    def test_complete_out_of_range(self):
        tasks = TaskList()
        with self.assertRaises(IndexError):
            tasks.complete(5)


if __name__ == "__main__":
    unittest.main()
