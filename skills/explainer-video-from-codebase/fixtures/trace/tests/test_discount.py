import unittest

from shop.cart import discount_for


class DiscountTest(unittest.TestCase):
    def test_threshold(self):
        self.assertEqual(discount_for(100), 10)
        self.assertEqual(discount_for(99), 0)
